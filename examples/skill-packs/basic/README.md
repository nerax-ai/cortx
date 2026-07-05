# Basic Cortx Skill Pack

This example shows a file-only skill pack. It contains a `SKILL.md` asset and an AgentSpec JSON file; no JavaScript plugin code is required.

The pack declares the v1 asset manifest in `skill-pack.json`:

```json
{
  "schemaVersion": 1,
  "name": "basic-skill-pack",
  "skillPaths": ["skills"],
  "agentSpecPaths": ["agents"]
}
```

Use the spec with runtime or server launch APIs:

```json
{
  "path": "examples/skill-packs/basic/agents/reviewer.json"
}
```
