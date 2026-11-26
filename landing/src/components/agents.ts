// Marks from the icon set the plugin draws agents with (@thesvg/icons, MIT), its own dependency.
import { svg as beekeeper } from "../../../packages/plugin/node_modules/@thesvg/icons/dist/beekeeper-studio.js";
import { svg as claude } from "../../../packages/plugin/node_modules/@thesvg/icons/dist/claude-code.js";
import { svg as codex } from "../../../packages/plugin/node_modules/@thesvg/icons/dist/codex.js";
import { svg as cursor } from "../../../packages/plugin/node_modules/@thesvg/icons/dist/cursor.js";
import { svg as gemini } from "../../../packages/plugin/node_modules/@thesvg/icons/dist/gemini.js";
import { svg as github } from "../../../packages/plugin/node_modules/@thesvg/icons/dist/github.js";
import { svg as kimi } from "../../../packages/plugin/node_modules/@thesvg/icons/dist/kimi.js";
import { svg as opencode } from "../../../packages/plugin/node_modules/@thesvg/icons/dist/opencode.js";

// Brand files carry an XML prolog, comments and their own colours; the page paints them amber.
const mark = (svg: string) =>
  svg.replace(
    /<\?xml[^>]*>|<!--[\s\S]*?-->|<defs>[\s\S]*?<\/defs>|<style>[\s\S]*?<\/style>|<title>[\s\S]*?<\/title>/g,
    "",
  );

export const agents: [name: string, svg: string][] = [
  ["Claude Code", mark(claude)],
  ["Codex", mark(codex)],
  ["OpenCode", mark(opencode)],
  ["Gemini", mark(gemini)],
  ["Kimi", mark(kimi)],
  ["Cursor", mark(cursor)],
];

export const githubMark = mark(github);
export const beekeeperMark = mark(beekeeper);
