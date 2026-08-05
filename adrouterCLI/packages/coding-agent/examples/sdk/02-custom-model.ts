/**
 * Custom Model Selection
 *
 * Shows how to select a specific model and thinking level.
 */

import { AuthStorage, createAgentSession, ModelRegistry } from "@adrouter/cli";

// Set up auth storage and model registry
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

// Find a generated official model by provider/id.
const model = modelRegistry.find("adrouter", "deepseek-v4-pro");
if (model) console.log(`Found model: ${model.provider}/${model.id}`);

// Pick from available official models (have valid AdRouter authentication).
const available = await modelRegistry.getAvailable();
console.log(
	"Available models:",
	available.map((m) => `${m.provider}/${m.id}`),
);

if (available.length > 0) {
	const { session } = await createAgentSession({
		model: available[0],
		thinkingLevel: "medium", // off, low, medium, high
		authStorage,
		modelRegistry,
	});

	try {
		session.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				process.stdout.write(event.assistantMessageEvent.delta);
			}
		});

		await session.prompt("Say hello in one sentence.");
		console.log();
	} finally {
		session.dispose();
	}
}
