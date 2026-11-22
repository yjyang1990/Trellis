---
name: trellis-check
description: Trellis quality check agent. Use this exact agent for Trellis task verification, check.jsonl context injection, and self-fixing code review. Do not use generic/default/generalPurpose agents for Trellis checks.
tools: Read, Write, Edit, Bash, Glob, Grep
---
{{AGENT_BODY:hook-check}}
