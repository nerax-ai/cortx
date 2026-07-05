---
date: 2026-07-05
topic: feat-asset-schema-migration
status: completed
scope: runtime assets
language: zh-CN
---

# AgentSpec / SkillPack Schema Migration Plan

## 目标

让 AgentSpec、SkillPack manifest 和本地 SkillPack install registry 具备第一版版本迁移边界：

- 当前公开 schema 仍保持 `1`。
- 缺省版本和历史 `0` 版本按兼容规则迁移到 `1`。
- 不支持的未来版本继续明确报错，不做静默降级。
- registry 读取旧记录后，下一次 install/write 会写回当前 `schemaVersion: 1`。

## 非目标

- 不引入 pack lockfile、签名、marketplace 或远程发布协议。
- 不改变 core，不改变 session/runtime 主流程。
- 不扩大公共 API；优先把迁移逻辑收在 runtime asset 层。

## 实施步骤

1. 为 AgentSpec 补 v0/missing/future schema 行为测试。
2. 为 SkillPack manifest 补 v0/missing/future schema 行为测试。
3. 为 SkillPack install registry 补 registry v0 / record v0 迁移和写回当前 schema 的测试。
4. 增加轻量 migration helper，复用当前 validator，保持错误信息明确。
5. 更新 remaining-work 文档，把“跨版本 migration 第一版”标记为已落地，保留 lockfile/signing/marketplace 等后续项。

## 验收

- `bun test packages/runtime/tests/agent-spec.test.ts packages/runtime/tests/skill-pack.test.ts`
- `bun run build`
- `bun run lint`
- `bun test`
- `git diff --check`
