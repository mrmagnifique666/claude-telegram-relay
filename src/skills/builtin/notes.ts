/**
 * Built-in skill: notes (add / list / search)
 * Simple in-memory note store per session.
 */
import { registerSkill } from "../loader.js";

interface Note {
  id: number;
  text: string;
  createdAt: string;
}

const notes: Note[] = [];
let nextId = 1;

registerSkill({
  name: "notes.add",
  description: "Add a new note.",
  argsSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The note content" },
    },
    required: ["text"],
  },
  async execute(args): Promise<string> {
    const text = args.text as string;
    const note: Note = { id: nextId++, text, createdAt: new Date().toISOString() };
    notes.push(note);
    return `Note #${note.id} saved.`;
  },
});

registerSkill({
  name: "notes.list",
  description: "List all saved notes.",
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    if (notes.length === 0) return "No notes yet.";
    return notes
      .map((n) => `#${n.id} [${n.createdAt}]: ${n.text}`)
      .join("\n");
  },
});

registerSkill({
  name: "notes.search",
  description: "Search notes by keyword.",
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search keyword" },
    },
    required: ["query"],
  },
  async execute(args): Promise<string> {
    const query = (args.query as string).toLowerCase();
    const found = notes.filter((n) => n.text.toLowerCase().includes(query));
    if (found.length === 0) return `No notes matching "${args.query}".`;
    return found
      .map((n) => `#${n.id}: ${n.text}`)
      .join("\n");
  },
});
