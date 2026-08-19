import {describe, expect, it} from "vitest";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {syncSkillPolicyFiles} from "../skillPolicyBridge";

const GENERATED = [
    "# generated-by: codex-acp skill-policy-bridge (from SKILL.md `disable-model-invocation: true`)",
    "policy:",
    "  allow_implicit_invocation: false",
    "",
].join("\n");

function writeSkill(root: string, name: string, frontmatter: string): string {
    const skillDir = join(root, name);
    mkdirSync(skillDir, {recursive: true});
    writeFileSync(join(skillDir, "SKILL.md"), frontmatter, "utf8");
    return skillDir;
}

function yamlPath(skillDir: string): string {
    return join(skillDir, "agents", "openai.yaml");
}

function frontmatter(extraLine: string | null): string {
    const lines = ["---", "name: foo", "description: bar"];
    if (extraLine !== null) lines.push(extraLine);
    lines.push("---");
    return lines.join("\n");
}

describe("syncSkillPolicyFiles", () => {
    function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
        const root = mkdtempSync(join(tmpdir(), "codex-acp-policy-"));
        return fn(root).finally(() => rmSync(root, {recursive: true, force: true}));
    }

    it("creates openai.yaml when the frontmatter disables model invocation", async () => {
        await withRoot(async (root) => {
            const skillDir = writeSkill(root, "foo", frontmatter("disable-model-invocation: true"));
            await syncSkillPolicyFiles([root]);
            expect(readFileSync(yamlPath(skillDir), "utf8")).toBe(GENERATED);
        });
    });

    it("leaves a user-authored openai.yaml untouched", async () => {
        await withRoot(async (root) => {
            const skillDir = writeSkill(root, "foo", frontmatter("disable-model-invocation: true"));
            const yaml = yamlPath(skillDir);
            mkdirSync(join(skillDir, "agents"), {recursive: true});
            writeFileSync(yaml, "policy:\n  allow_implicit_invocation: true\n", "utf8");
            await syncSkillPolicyFiles([root]);
            expect(readFileSync(yaml, "utf8")).toBe("policy:\n  allow_implicit_invocation: true\n");
        });
    });

    it("reclaims a generated openai.yaml when the flag is removed", async () => {
        await withRoot(async (root) => {
            const skillDir = writeSkill(root, "foo", frontmatter(null));
            const yaml = yamlPath(skillDir);
            mkdirSync(join(skillDir, "agents"), {recursive: true});
            writeFileSync(yaml, GENERATED, "utf8");
            await syncSkillPolicyFiles([root]);
            expect(existsSync(yaml)).toBe(false);
            expect(existsSync(join(skillDir, "agents"))).toBe(false);
        });
    });

    it("does not generate when the frontmatter lacks the flag", async () => {
        await withRoot(async (root) => {
            const skillDir = writeSkill(root, "foo", frontmatter(null));
            await syncSkillPolicyFiles([root]);
            expect(existsSync(yamlPath(skillDir))).toBe(false);
        });
    });

    it("ignores a missing skills root without error", async () => {
        await withRoot(async (root) => {
            await expect(syncSkillPolicyFiles([join(root, "nope")])).resolves.toBeUndefined();
        });
    });
});
