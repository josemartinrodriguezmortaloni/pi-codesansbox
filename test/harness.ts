/**
 * Test harness: a real Pi session runtime that loads this package from disk (the same discovery
 * path as `pi -e <dir>`), with a scripted faux model that issues `eval` calls.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { type Context, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	type AgentSessionRuntime,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export type Call = { name: string; args: Record<string, unknown> };

export interface Harness {
	runtime: AgentSessionRuntime;
	cwd: string;
	/** Model contexts the faux provider received, in order. */
	contexts: Context[];
	/** Runs the calls as one assistant turn and returns their results in call order. */
	run(calls: Call[]): Promise<ToolResultMessage[]>;
	dispose(): Promise<void>;
}

export const py = (code: string, extra: Record<string, unknown> = {}): Call => ({ name: "eval", args: { language: "py", code, ...extra } });
export const js = (code: string, extra: Record<string, unknown> = {}): Call => ({ name: "eval", args: { language: "js", code, ...extra } });

export async function createHarness(): Promise<Harness> {
	const root = mkdtempSync(join(tmpdir(), "pi-eval-test-"));
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	const faux = fauxProvider({
		provider: "faux-eval",
		api: "faux-eval-api",
		models: [{ id: "faux-1", input: ["text", "image"] }],
	});
	const contexts: Context[] = [];
	const runtime = await createAgentSessionRuntime(
		async ({ cwd: sessionCwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd: sessionCwd,
				agentDir,
				settingsManager: SettingsManager.inMemory({}),
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					additionalExtensionPaths: [PACKAGE_ROOT],
					extensionFactories: [
						(pi) => {
							pi.registerProvider(faux.provider.id, {
								api: faux.api,
								baseUrl: faux.getModel().baseUrl,
								apiKey: "faux-key",
								models: faux.models,
								streamSimple: faux.provider.streamSimple,
							});
						},
					],
				},
			});
			const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
			return { ...created, services, diagnostics: services.diagnostics };
		},
		{ cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) },
	);
	await runtime.session.bindExtensions({});
	const model = runtime.session.modelRuntime.getModel(faux.provider.id, "faux-1");
	if (!model) throw new Error("faux model not registered");
	await runtime.session.setModel(model);

	const run = async (calls: Call[]): Promise<ToolResultMessage[]> => {
		const before = runtime.session.messages.length;
		faux.setResponses([
			fauxAssistantMessage(calls.map((call) => fauxToolCall(call.name, call.args as Parameters<typeof fauxToolCall>[1]))),
			(context) => {
				contexts.push(structuredClone(context));
				return fauxAssistantMessage("done");
			},
		]);
		await runtime.session.prompt("run");
		return runtime.session.messages
			.slice(before)
			.filter((message): message is ToolResultMessage => message.role === "toolResult");
	};

	const dispose = async (): Promise<void> => {
		await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
	};
	return { runtime, cwd, contexts, run, dispose };
}

export function textOf(result: ToolResultMessage): string {
	return result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

export function imagesOf(result: ToolResultMessage): Array<{ data: string; mimeType: string }> {
	return result.content.flatMap((block) => (block.type === "image" ? [block] : []));
}

/** Whether a process with this pid exists (zombies of exited kernels count as gone). */
export function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	return !isZombie(pid);
}

function isZombie(pid: number): boolean {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
	} catch {
		return true;
	}
}
