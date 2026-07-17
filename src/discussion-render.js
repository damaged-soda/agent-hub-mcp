export function renderDecisionMarkdown(decision, metadata = {}) {
  const lines = [
    "# Discussion Decision",
    "",
    decision.recommendation.summary,
    "",
    `- Conclusion: ${decision.conclusion_strength}`,
    `- Protocol integrity: ${metadata.protocol_integrity ?? "unknown"}`,
    `- Confidence: ${decision.confidence.level} — ${decision.confidence.rationale}`,
    "- Workspace policy: best-effort read-only; not a security boundary",
  ];
  pushList(lines, "Conditions", decision.recommendation.conditions);
  pushProvenanced(lines, "Consensus", decision.consensus);
  pushProvenanced(lines, "Disagreements", decision.disagreements);
  pushEvidence(lines, decision.evidence);
  pushProvenanced(lines, "Rejected options", decision.rejected_options);
  pushProvenanced(lines, "Risks", decision.risks);
  pushProvenanced(lines, "Uncertainties", decision.uncertainties);
  pushList(lines, "Host inferences", decision.host_inferences);
  pushList(lines, "Next actions", decision.next_actions);
  if (Array.isArray(metadata.effective_configurations)) {
    lines.push("", "## Runtime disclosure", "", "```json");
    lines.push(JSON.stringify(metadata.effective_configurations, null, 2));
    lines.push("```");
  }
  return `${lines.join("\n")}\n`;
}

function pushList(lines, title, items) {
  if (!items?.length) return;
  lines.push("", `## ${title}`, "");
  for (const item of items) lines.push(`- ${item}`);
}

function pushProvenanced(lines, title, items) {
  if (!items?.length) return;
  lines.push("", `## ${title}`, "");
  for (const item of items) {
    lines.push(`- ${item.statement} (${item.provenance.join(", ")})`);
  }
}

function pushEvidence(lines, items) {
  if (!items?.length) return;
  lines.push("", "## Evidence", "");
  for (const item of items) {
    lines.push(`- [${item.status}] ${item.statement} (${item.provenance.join(", ")})`);
  }
}
