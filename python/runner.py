"""Persistent Python kernel for pi-eval-kernels.

The design follows the IPython-free runner of oh-my-pi's `eval` tool
(packages/coding-agent/src/eval/py/runner.py, MIT License,
Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük,
Copyright (c) 2026 Stencil Labs, Inc.). See NOTICE for the full license text.

Protocol: NDJSON. Requests arrive on the original stdin; frames leave on a
duplicate of the original stdout. fd 0 is replaced with /dev/null and fd 1 is
redirected to fd 2, so user code and its child processes cannot corrupt the
protocol stream.

Host -> kernel: {"type":"init","bridgeUrl":str,"bridgeToken":str} (first line only)
                {"type":"run","id":str,"code":str} | {"type":"exit"}
Kernel -> host: {"type":"ready","pid":int}
                {"type":"stream","id":str,"name":"stdout"|"stderr","text":str}
                {"type":"display","id":str,"text":str?,"png":base64?}
                {"type":"done","id":str,"status":"ok"|"error"|"cancelled","error":str?}
"""

import ast
import asyncio
import base64
import builtins
import io
import inspect
import json
import linecache
import os
import signal
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request

PROTO_OUT = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
PROTO_IN = os.fdopen(os.dup(0), "r", encoding="utf-8")
_SEND_LOCK = threading.Lock()
# Bridge address and token arrive on the protocol channel, not in the environment, so other
# processes of the same user cannot read the token from /proc/<pid>/environ.
_BRIDGE = {"url": "", "token": ""}
_CURRENT = {"id": None}
_SHOWN_FIGURES = set()
_COMPILE_FLAGS = ast.PyCF_ALLOW_TOP_LEVEL_AWAIT
_LOOP = asyncio.new_event_loop()
_RUNNER_FILE = os.path.abspath(__file__)


def send(frame):
    line = json.dumps(frame, ensure_ascii=False)
    with _SEND_LOCK:
        PROTO_OUT.write(line + "\n")
        PROTO_OUT.flush()


def _isolate_std_fds():
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    os.close(devnull)
    os.dup2(2, 1)


class _CellStream(io.TextIOBase):
    """Line-buffered text stream that forwards writes as `stream` frames."""

    def __init__(self, name):
        self.name = name
        self._buffer = []
        self._size = 0
        self._lock = threading.Lock()

    def writable(self):
        return True

    def write(self, text):
        with self._lock:
            self._buffer.append(text)
            self._size += len(text)
        if "\n" in text or self._size > 4096:
            self.flush()
        return len(text)

    def flush(self):
        with self._lock:
            text = "".join(self._buffer)
            self._buffer, self._size = [], 0
        if text:
            send({"type": "stream", "id": _CURRENT["id"], "name": self.name, "text": text})

    def isatty(self):
        return False


# ---------------------------------------------------------------- display


def _is_figure(obj):
    module = type(obj).__module__ or ""
    return module.startswith("matplotlib.figure") and hasattr(obj, "savefig")


def _figure_png(fig):
    buffer = io.BytesIO()
    fig.savefig(buffer, format="png", bbox_inches="tight")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def _call_repr_png(obj):
    method = getattr(obj, "_repr_png_", None)
    return method() if callable(method) and not isinstance(obj, type) else None


def _repr_png(obj):
    data = _call_repr_png(obj)
    return base64.b64encode(data).decode("ascii") if isinstance(data, bytes) else None


def _figure_bundle(fig):
    if id(fig) in _SHOWN_FIGURES:
        return {"text": repr(fig)}
    _SHOWN_FIGURES.add(id(fig))
    return {"png": _figure_png(fig), "text": repr(fig)}


def _bundle(obj):
    if _is_figure(obj):
        return _figure_bundle(obj)
    png = _repr_png(obj)
    return {"png": png} if png else {"text": repr(obj)}


def display(*objects):
    """Show objects in the cell output: figures and `_repr_png_` objects as images, others as repr."""
    for obj in objects:
        _flush_streams()
        send({"type": "display", "id": _CURRENT["id"], **_bundle(obj)})


def display_png(data, text=None):
    """Show raw PNG bytes (or a base64 string) as an image."""
    encoded = base64.b64encode(data).decode("ascii") if isinstance(data, bytes) else data
    send({"type": "display", "id": _CURRENT["id"], "png": encoded, **({"text": text} if text else {})})


def emit_figure(fig):
    """Called by the inline matplotlib backend on plt.show()."""
    display_png(_figure_png(fig))
    _SHOWN_FIGURES.add(id(fig))


def _flush_open_figures():
    pyplot = sys.modules.get("matplotlib.pyplot")
    if pyplot is None:
        return
    for number in pyplot.get_fignums():
        _emit_unshown(pyplot.figure(number))
    pyplot.close("all")
    _SHOWN_FIGURES.clear()


def _emit_unshown(fig):
    if id(fig) not in _SHOWN_FIGURES:
        display_png(_figure_png(fig))


def _flush_streams():
    sys.stdout.flush()
    sys.stderr.flush()


# ---------------------------------------------------------------- tool bridge


class ToolError(Exception):
    """A nested tool call failed, was blocked, or got invalid arguments."""


_NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _bridge_http_request(path, body):
    url = _BRIDGE["url"] + path
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, method="GET" if data is None else "POST")
    request.add_header("Authorization", "Bearer " + _BRIDGE["token"])
    request.add_header("Content-Type", "application/json")
    return request


def _bridge_request(path, body=None):
    request = _bridge_http_request(path, body)
    try:
        with _NO_PROXY.open(request) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return json.loads(error.read().decode("utf-8") or "{}")


def _call_tool(name, args):
    reply = _bridge_request("/v1/tools/call", {"name": name, "args": args})
    if not reply.get("ok"):
        raise ToolError(reply.get("error") or f"Tool {name!r} failed")
    _show_images(reply)
    return reply.get("value")


def _show_images(reply):
    """Images in a nested tool result (for example `read` of a PNG) become cell images."""
    for image in reply.get("images", []):
        display_png(image["data"])


def list_tools():
    """Names and descriptions of the tools callable through `tool.<name>(...)`."""
    return _bridge_request("/v1/tools").get("tools", [])


class _ToolFunction:
    def __init__(self, name):
        self.__name__ = name

    def __call__(self, args=None, /, **kwargs):
        return _call_tool(self.__name__, {**(args or {}), **kwargs})

    def __repr__(self):
        return f"<tool {self.__name__}>"


class _ToolProxy:
    """`tool.read(path="x")` or `tool["mcp-name"]({...})` calls the agent tool of that name."""

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return _ToolFunction(name)

    def __getitem__(self, name):
        return _ToolFunction(name)

    def __dir__(self):
        return [entry["name"] for entry in list_tools()]

    def __repr__(self):
        return "<tool bridge>"


# ---------------------------------------------------------------- execution

USER_NS = {
    "__name__": "__main__",
    "__builtins__": builtins,
    "tool": _ToolProxy(),
    "ToolError": ToolError,
    "list_tools": list_tools,
    "display": display,
    "display_png": display_png,
}


def _split_last_expression(tree):
    last = tree.body[-1] if tree.body else None
    if not isinstance(last, ast.Expr):
        return tree, None
    tree.body.pop()
    return tree, ast.Expression(last.value)


def _evaluate(code_object):
    result = eval(code_object, USER_NS)
    if inspect.CO_COROUTINE & code_object.co_flags:
        result = _LOOP.run_until_complete(result)
    return result


def _register_source(code, filename):
    linecache.cache[filename] = (len(code), None, code.splitlines(True), filename)


def _execute(code, filename):
    _register_source(code, filename)
    tree = ast.parse(code, filename, "exec")
    body, last = _split_last_expression(tree)
    _evaluate(compile(body, filename, "exec", flags=_COMPILE_FLAGS))
    if last is None:
        return
    value = _evaluate(compile(last, filename, "eval", flags=_COMPILE_FLAGS))
    _show_result(value)


def _show_result(value):
    if value is None:
        return
    USER_NS["_"] = value
    display(value)


def _user_frames(error):
    """Traceback frames without the runner's own frames."""
    summary = traceback.extract_tb(error.__traceback__)
    return [frame for frame in summary if frame.filename != _RUNNER_FILE]


def _user_traceback(error):
    frames = _user_frames(error)
    lines = traceback.format_list(frames)
    lines += traceback.format_exception_only(type(error), error)
    return "Traceback (most recent call last):\n" + "".join(lines) if frames else "".join(lines)


def _reset_loop():
    global _LOOP
    _LOOP.close()
    _LOOP = asyncio.new_event_loop()


def _run_guarded(code, filename):
    try:
        _execute(code, filename)
        return {"status": "ok"}
    except KeyboardInterrupt:
        _reset_loop()
        return {"status": "cancelled", "error": "KeyboardInterrupt"}
    except BaseException as error:  # noqa: BLE001 - every user error becomes a cell error
        sys.stderr.write(_user_traceback(error))
        return {"status": "error", "error": f"{type(error).__name__}: {error}"}


def _finish_cell():
    try:
        _flush_open_figures()
    except Exception as error:  # noqa: BLE001
        sys.stderr.write(f"[figure flush failed: {error}]\n")
    _flush_streams()


def run_cell(request):
    _CURRENT["id"] = request["id"]
    signal.signal(signal.SIGINT, signal.default_int_handler)
    try:
        outcome = _run_guarded(request["code"], f"<cell-{request['id']}>")
    finally:
        signal.signal(signal.SIGINT, signal.SIG_IGN)
    _finish_cell()
    send({"type": "done", "id": request["id"], **outcome})
    _CURRENT["id"] = None


def _watch_parent(parent_pid):
    while os.getppid() == parent_pid:
        time.sleep(1)
    os._exit(0)


def main():
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    _isolate_std_fds()
    sys.stdout = _CellStream("stdout")
    sys.stderr = _CellStream("stderr")
    sys.stdin = io.StringIO("")
    sys.modules["__pi_kernel__"] = sys.modules[__name__]
    threading.Thread(target=_watch_parent, args=(os.getppid(),), daemon=True).start()
    init = json.loads(PROTO_IN.readline())
    _BRIDGE.update(url=init["bridgeUrl"], token=init["bridgeToken"])
    send({"type": "ready", "pid": os.getpid()})
    for line in PROTO_IN:
        request = json.loads(line)
        if request.get("type") == "exit":
            break
        run_cell(request)
    os._exit(0)


if __name__ == "__main__":
    main()
