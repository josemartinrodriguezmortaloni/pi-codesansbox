// Extension for the CLI test: a faux model that runs one Python and one JavaScript cell.
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
	const faux = fauxProvider({ provider: "faux-eval", api: "faux-eval-api", models: [{ id: "faux-1", input: ["text", "image"] }] });
	faux.setResponses([
		fauxAssistantMessage([
			fauxToolCall("eval", { language: "py", code: 'import os\nprint(os.getpid(), tool.read(path="note.txt"))' }),
			fauxToolCall("eval", { language: "js", code: 'console.log(process.pid, await tool.read({ path: "note.txt" }))' }),
		]),
		fauxAssistantMessage("done"),
	]);
	pi.registerProvider(faux.provider.id, {
		api: faux.api,
		baseUrl: faux.getModel().baseUrl,
		apiKey: "faux-key",
		models: faux.models,
		streamSimple: faux.provider.streamSimple,
	});
}
