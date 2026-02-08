/**
 * Built-in skills: office.*
 * Document creation via Python (python-docx, openpyxl, python-pptx).
 * Bastion OS — Kingston can create Word, Excel, PowerPoint, and CSV files.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { registerSkill } from "../loader.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";

const OUTPUT_DIR = path.resolve(config.sandboxDir, "documents");

function ensureOutputDir(): void {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

/** Run a Python script and return its stdout. */
function runPython(script: string, timeoutMs = 30000): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn("python", ["-c", script], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

    proc.on("error", (err) => resolve(`Error: ${err.message}`));
    proc.on("close", (code) => {
      if (code !== 0) {
        resolve(`Error (exit ${code}): ${stderr.slice(0, 500) || stdout.slice(0, 500)}`);
      } else {
        resolve(stdout.trim() || "(done)");
      }
    });
  });
}

// ── office.document ─────────────────────────────────────────

registerSkill({
  name: "office.document",
  description:
    "Create a Word document (.docx). Provide a title, optional subtitle, and content as markdown-like text. Paragraphs separated by blank lines. Lines starting with # become headings.",
  argsSchema: {
    type: "object",
    properties: {
      filename: { type: "string", description: 'Output filename (e.g. "report.docx")' },
      title: { type: "string", description: "Document title" },
      subtitle: { type: "string", description: "Optional subtitle" },
      content: { type: "string", description: "Document body. Use # for headings, blank lines for paragraphs, - for bullet points." },
    },
    required: ["filename", "title", "content"],
  },
  async execute(args): Promise<string> {
    ensureOutputDir();
    const filename = path.basename(String(args.filename)).replace(/[<>:"/\\|?*]/g, "_");
    const outPath = path.join(OUTPUT_DIR, filename.endsWith(".docx") ? filename : filename + ".docx");
    const title = String(args.title);
    const subtitle = args.subtitle ? String(args.subtitle) : "";
    const content = String(args.content);

    const script = `
import sys
from docx import Document
from docx.shared import Pt, Inches
from docx.enum.text import WD_ALIGN_PARAGRAPH

doc = Document()

# Title
t = doc.add_heading(${JSON.stringify(title)}, level=0)
t.alignment = WD_ALIGN_PARAGRAPH.CENTER

${subtitle ? `doc.add_paragraph(${JSON.stringify(subtitle)}).alignment = WD_ALIGN_PARAGRAPH.CENTER` : ""}

content = ${JSON.stringify(content)}
for line in content.split("\\n"):
    line = line.strip()
    if not line:
        continue
    if line.startswith("### "):
        doc.add_heading(line[4:], level=3)
    elif line.startswith("## "):
        doc.add_heading(line[3:], level=2)
    elif line.startswith("# "):
        doc.add_heading(line[2:], level=1)
    elif line.startswith("- ") or line.startswith("* "):
        doc.add_paragraph(line[2:], style="List Bullet")
    elif line.startswith("1. ") or line.startswith("2. ") or line.startswith("3. "):
        doc.add_paragraph(line[3:], style="List Number")
    else:
        doc.add_paragraph(line)

doc.save(${JSON.stringify(outPath)})
print(f"Created: ${outPath}")
print(f"Paragraphs: {len(doc.paragraphs)}")
`;

    const result = await runPython(script);
    log.info(`[office] Document created: ${outPath}`);
    return result;
  },
});

// ── office.spreadsheet ──────────────────────────────────────

registerSkill({
  name: "office.spreadsheet",
  description:
    "Create an Excel spreadsheet (.xlsx). Provide headers and rows as JSON arrays. Can include multiple sheets.",
  argsSchema: {
    type: "object",
    properties: {
      filename: { type: "string", description: 'Output filename (e.g. "data.xlsx")' },
      title: { type: "string", description: "Sheet title / name" },
      headers: { type: "string", description: 'JSON array of column headers, e.g. ["Name", "Age", "City"]' },
      rows: { type: "string", description: 'JSON array of arrays, e.g. [["Alice", 30, "Montreal"], ["Bob", 25, "Quebec"]]' },
    },
    required: ["filename", "headers", "rows"],
  },
  async execute(args): Promise<string> {
    ensureOutputDir();
    const filename = path.basename(String(args.filename)).replace(/[<>:"/\\|?*]/g, "_");
    const outPath = path.join(OUTPUT_DIR, filename.endsWith(".xlsx") ? filename : filename + ".xlsx");
    const title = args.title ? String(args.title) : "Sheet1";

    let headers: string[];
    let rows: unknown[][];
    try {
      headers = JSON.parse(String(args.headers));
      rows = JSON.parse(String(args.rows));
    } catch {
      return "Error: headers and rows must be valid JSON arrays.";
    }

    const script = `
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

wb = Workbook()
ws = wb.active
ws.title = ${JSON.stringify(title)}

headers = ${JSON.stringify(headers)}
rows = ${JSON.stringify(rows)}

# Header row with styling
header_font = Font(bold=True, color="FFFFFF", size=11)
header_fill = PatternFill(start_color="2F5496", end_color="2F5496", fill_type="solid")
thin_border = Border(
    left=Side(style="thin"), right=Side(style="thin"),
    top=Side(style="thin"), bottom=Side(style="thin")
)

for col, h in enumerate(headers, 1):
    cell = ws.cell(row=1, column=col, value=h)
    cell.font = header_font
    cell.fill = header_fill
    cell.alignment = Alignment(horizontal="center")
    cell.border = thin_border

# Data rows
for r, row_data in enumerate(rows, 2):
    for c, val in enumerate(row_data, 1):
        cell = ws.cell(row=r, column=c, value=val)
        cell.border = thin_border

# Auto-width columns
for col in ws.columns:
    max_len = max(len(str(cell.value or "")) for cell in col)
    ws.column_dimensions[col[0].column_letter].width = min(max_len + 4, 50)

wb.save(${JSON.stringify(outPath)})
print(f"Created: ${outPath}")
print(f"Rows: {len(rows)}, Columns: {len(headers)}")
`;

    const result = await runPython(script);
    log.info(`[office] Spreadsheet created: ${outPath}`);
    return result;
  },
});

// ── office.presentation ─────────────────────────────────────

registerSkill({
  name: "office.presentation",
  description:
    "Create a PowerPoint presentation (.pptx). Provide an array of slides, each with a title and bullet points.",
  argsSchema: {
    type: "object",
    properties: {
      filename: { type: "string", description: 'Output filename (e.g. "deck.pptx")' },
      title: { type: "string", description: "Presentation title (first slide)" },
      subtitle: { type: "string", description: "First slide subtitle" },
      slides: { type: "string", description: 'JSON array of slides: [{"title":"Slide 1","bullets":["Point A","Point B"]}, ...]' },
    },
    required: ["filename", "title", "slides"],
  },
  async execute(args): Promise<string> {
    ensureOutputDir();
    const filename = path.basename(String(args.filename)).replace(/[<>:"/\\|?*]/g, "_");
    const outPath = path.join(OUTPUT_DIR, filename.endsWith(".pptx") ? filename : filename + ".pptx");

    let slides: Array<{ title: string; bullets?: string[] }>;
    try {
      slides = JSON.parse(String(args.slides));
    } catch {
      return "Error: slides must be a valid JSON array.";
    }

    const script = `
from pptx import Presentation
from pptx.util import Inches, Pt

prs = Presentation()

# Title slide
title_slide = prs.slides.add_slide(prs.slide_layouts[0])
title_slide.shapes.title.text = ${JSON.stringify(String(args.title))}
${args.subtitle ? `title_slide.placeholders[1].text = ${JSON.stringify(String(args.subtitle))}` : ""}

slides = ${JSON.stringify(slides)}
for s in slides:
    slide = prs.slides.add_slide(prs.slide_layouts[1])
    slide.shapes.title.text = s.get("title", "")
    body = slide.placeholders[1]
    tf = body.text_frame
    tf.clear()
    for i, bullet in enumerate(s.get("bullets", [])):
        if i == 0:
            tf.text = bullet
        else:
            p = tf.add_paragraph()
            p.text = bullet

prs.save(${JSON.stringify(outPath)})
print(f"Created: ${outPath}")
print(f"Slides: {len(prs.slides)}")
`;

    const result = await runPython(script);
    log.info(`[office] Presentation created: ${outPath}`);
    return result;
  },
});

// ── office.csv ──────────────────────────────────────────────

registerSkill({
  name: "office.csv",
  description: "Create a CSV file. Provide headers and rows as JSON arrays.",
  argsSchema: {
    type: "object",
    properties: {
      filename: { type: "string", description: 'Output filename (e.g. "export.csv")' },
      headers: { type: "string", description: 'JSON array of column headers' },
      rows: { type: "string", description: 'JSON array of arrays' },
    },
    required: ["filename", "headers", "rows"],
  },
  async execute(args): Promise<string> {
    ensureOutputDir();
    const filename = path.basename(String(args.filename)).replace(/[<>:"/\\|?*]/g, "_");
    const outPath = path.join(OUTPUT_DIR, filename.endsWith(".csv") ? filename : filename + ".csv");

    let headers: string[];
    let rows: unknown[][];
    try {
      headers = JSON.parse(String(args.headers));
      rows = JSON.parse(String(args.rows));
    } catch {
      return "Error: headers and rows must be valid JSON arrays.";
    }

    // Build CSV content (handle commas in values)
    const escape = (v: unknown) => {
      const s = String(v ?? "");
      return s.includes(",") || s.includes('"') || s.includes("\n")
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };

    const lines = [
      headers.map(escape).join(","),
      ...rows.map((row) => (row as unknown[]).map(escape).join(",")),
    ];

    fs.writeFileSync(outPath, lines.join("\n"), "utf-8");
    log.info(`[office] CSV created: ${outPath}`);
    return `Created: ${outPath}\nRows: ${rows.length}, Columns: ${headers.length}`;
  },
});

// ── office.list ─────────────────────────────────────────────

registerSkill({
  name: "office.list",
  description: "List all documents created by Bastion in the documents folder.",
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    ensureOutputDir();
    try {
      const files = fs.readdirSync(OUTPUT_DIR);
      if (files.length === 0) return "No documents yet.";
      const details = files.map((f) => {
        const stat = fs.statSync(path.join(OUTPUT_DIR, f));
        const size = stat.size < 1024 ? `${stat.size}B` : `${Math.round(stat.size / 1024)}KB`;
        const date = stat.mtime.toISOString().split("T")[0];
        return `- ${f} (${size}, ${date})`;
      });
      return `Documents in ${OUTPUT_DIR}:\n${details.join("\n")}`;
    } catch {
      return "Error listing documents.";
    }
  },
});
