import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

type ProviderChatModelConfig = Extract<ProviderModelConfig, { reasoning: boolean }>;
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";

/**
 * Chat models offered through Claude Code, with limits, prices and thinking levels taken from
 * pi's own Anthropic catalog so they track pi releases. Dated aliases are skipped; Claude Code
 * resolves the undated ids itself.
 */
export function claudeModels(): ProviderChatModelConfig[] {
	const out: ProviderChatModelConfig[] = [];
	for (const [id, m] of Object.entries(ANTHROPIC_MODELS as Record<string, any>)) {
		if (/-\d{8}$/.test(id)) continue;
		out.push({
			id,
			name: `${m.name} (Claude subscription)`,
			reasoning: m.reasoning,
			input: m.input,
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
			// No promptCache: Claude Code already writes one-hour cache entries, and pi's cache
			// warmer (a one-token replay of an earlier request) cannot be expressed through it.
		});
	}
	return out;
}

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/**
 * Map a pi thinking level to Agent SDK thinking options. pi resolves the level through the
 * model's thinkingLevelMap before it reaches the provider, so the value is already the
 * provider-native effort when the model declares one.
 */
export function thinkingOptions(
	level: string | undefined,
	hasLevelMap: boolean,
): { thinking: { type: "adaptive" } | { type: "disabled" } | { type: "enabled"; budgetTokens: number }; effort?: "low" | "medium" | "high" | "xhigh" | "max" } {
	if (!level || level === "off") return { thinking: { type: "disabled" } };
	if (hasLevelMap) {
		const effort = EFFORTS.has(level) ? (level as any) : level === "minimal" ? "low" : "medium";
		return { thinking: { type: "adaptive" }, effort };
	}
	// Budget-based models (e.g. Haiku 4.5).
	const budgets: Record<string, number> = { minimal: 1024, low: 4096, medium: 10240, high: 20480, xhigh: 32000, max: 48000 };
	return { thinking: { type: "enabled", budgetTokens: budgets[level] ?? 10240 } };
}
