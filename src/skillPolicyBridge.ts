import fs from "node:fs";
import path from "node:path";
import {logger} from "./Logger";

// fork-only: materialize codex's per-skill invocation policy from the Claude-side
// frontmatter. The native codex binary reads `policy.allow_implicit_invocation` from
// a skill's `agents/openai.yaml` (defaulting to allow when the file is absent) and
// ignores SKILL.md frontmatter, so a skill declaring `disable-model-invocation: true`
// must also get an openai.yaml that opts out of implicit invocation. The generated
// file carries a sentinel so it can be reclaimed when the frontmatter flag goes away;
// user-authored yaml (no sentinel) is never touched.
const SENTINEL = "generated-by: codex-acp skill-policy-bridge";

const POLICY_YAML = [
    `# ${SENTINEL} (from SKILL.md \`disable-model-invocation: true\`)`,
    "policy:",
    "  allow_implicit_invocation: false",
    "",
].join("\n");

/**
 * Reconcile each skill's `agents/openai.yaml` with its `disable-model-invocation`
 * frontmatter. `skillsRoots` are resolved skill roots (each entry's children are the
 * skill dirs); a missing root is skipped. Every IO failure degrades to a log line
 * rather than throwing — skill discovery must never break a session.
 */
export async function syncSkillPolicyFiles(skillsRoots: string[]): Promise<void> {
    for (const skillsRoot of skillsRoots) {
        for (const name of readSkillDirNames(skillsRoot)) {
            await syncSkill(path.join(skillsRoot, name));
        }
    }
}

function readSkillDirNames(skillsRoot: string): string[] {
    try {
        return fs
            .readdirSync(skillsRoot, {withFileTypes: true})
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
    } catch {
        return []; // root missing or unreadable — nothing to bridge
    }
}

async function syncSkill(skillDir: string): Promise<void> {
    let disableModelInvocation: boolean;
    try {
        disableModelInvocation = readDisableModelInvocation(
            fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8"),
        );
    } catch {
        return; // no SKILL.md / unreadable — not a skill we manage
    }

    const yamlPath = path.join(skillDir, "agents", "openai.yaml");
    const agentsDir = path.dirname(yamlPath);

    if (disableModelInvocation) {
        if (fs.existsSync(yamlPath)) return;
        try {
            fs.mkdirSync(agentsDir, {recursive: true});
            fs.writeFileSync(yamlPath, POLICY_YAML, "utf8");
            logger.log(`[skill-policy-bridge] wrote ${yamlPath}`);
        } catch (err) {
            logger.log(`[skill-policy-bridge] failed to write ${yamlPath}`, {exception: String(err)});
        }
        return;
    }

    // Flag absent/false → reclaim a generated file, leave handwritten yaml alone.
    if (!fs.existsSync(yamlPath)) return;
    try {
        const firstLine = fs.readFileSync(yamlPath, "utf8").split(/\r?\n/, 1)[0] ?? "";
        if (!firstLine.includes(SENTINEL)) return;
    } catch (err) {
        logger.log(`[skill-policy-bridge] failed to read ${yamlPath}`, {exception: String(err)});
        return;
    }
    try {
        fs.unlinkSync(yamlPath);
        try {
            fs.rmdirSync(agentsDir); // only removes it when empty
        } catch {
            // non-empty or already gone — fine
        }
        logger.log(`[skill-policy-bridge] removed ${yamlPath}`);
    } catch (err) {
        logger.log(`[skill-policy-bridge] failed to remove ${yamlPath}`, {exception: String(err)});
    }
}

function readDisableModelInvocation(skillMd: string): boolean {
    // Frontmatter is the leading `---` ... `---` block; match the flag line tolerating
    // surrounding whitespace. Absent or false → false.
    const lines = skillMd.split(/\r?\n/);
    if (lines[0]?.trim() !== "---") return false;
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined || line.trim() === "---") break;
        const match = /^\s*disable-model-invocation\s*:\s*(true|false)\s*$/.exec(line);
        if (match) return match[1] === "true";
    }
    return false;
}
