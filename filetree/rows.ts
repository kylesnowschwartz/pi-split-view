/**
 * Theme roles the file tree draws with. pi's Theme satisfies this shape.
 */
export type PaneRole =
	| "accent"
	| "border"
	| "dim"
	| "error"
	| "muted"
	| "success"
	| "text"
	| "toolDiffAdded"
	| "toolDiffRemoved"
	| "warning";

export interface PaneTheme {
	fg(role: PaneRole, text: string): string;
	bg(role: "selectedBg", text: string): string;
	bold(text: string): string;
	strikethrough(text: string): string;
	appearance?: string;
}
