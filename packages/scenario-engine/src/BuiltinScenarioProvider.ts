/**
 * Scenario Engine — PR-11
 *
 * Minimal ScenarioProvider that reads the built-in scenario set from
 * scenarios/builtin.json. This is the only file that knows the
 * built-in scenarios live in JSON now — the Runner does not.
 */

import type { ScenarioProvider } from "./ScenarioProvider"
import type { ScenarioSet } from "./ScenarioSet"
import { validateScenarioSet } from "./ScenarioSetValidator"
import builtinScenarioSetJson from "./scenarios/builtin.json" with { type: "json" }

/**
 * Synchronous helper used where an async load() is inconvenient
 * (e.g. wiring up the registry at app bootstrap). Goes through the
 * same validation as any external file, so a broken builtin.json
 * fails loudly instead of silently.
 */
export function loadBuiltinScenarioSet(): ScenarioSet {
    return validateScenarioSet(builtinScenarioSetJson)
}

export class BuiltinScenarioProvider implements ScenarioProvider {
    async load(): Promise<ScenarioSet> {
        return loadBuiltinScenarioSet()
    }
}
