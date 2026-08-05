import type { FauxProviderRegistration } from "@adrouter/ai/compat";
import type { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";

export function createFauxModelRegistry(faux: FauxProviderRegistration, authStorage: AuthStorage): ModelRegistry {
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	const model = faux.getModel();
	modelRegistry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((registeredModel) => ({
			id: registeredModel.id,
			name: registeredModel.name,
			api: registeredModel.api,
			reasoning: registeredModel.reasoning,
			input: registeredModel.input,
			cost: registeredModel.cost,
			contextWindow: registeredModel.contextWindow,
			maxTokens: registeredModel.maxTokens,
			baseUrl: registeredModel.baseUrl,
		})),
	});
	return modelRegistry;
}
