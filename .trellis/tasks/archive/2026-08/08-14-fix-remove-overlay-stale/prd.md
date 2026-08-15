# PRD: 修复 remove 高亮不生效（overlay 残留叠加）

## 背景

用户报告：`Highlighter: Remove Highlight` 不工作，被移除的术语高亮仍在屏幕上；`Clear All` 正常。

## 根因（已查证）

- Fresh 插件 API 中 `editor.addOverlay` 是**追加式**：每次调用新增一条 decoration，重复调用叠加（fresh-core `PluginApi::add_overlay` 文档明确 "Returns an opaque handle that can be used to remove the overlay later"；fresh-editor state.rs `apply_add_overlay` 直接追加）。
- 清除只能通过 `editor.clearNamespace(bufferId, namespace)`（fresh-editor `ClearNamespace` → `overlays.clear_namespace`）。
- 本插件 `applyToBuffer` 重建装饰时从不先清 namespace：只有 `enabled.length === 0` 时才调用 `clearNamespace`，但内置注解标签（TODO: 等 11 个）默认启用，`enabled.length` 恒 > 0，该分支永远走不到。
- 因此 `highlighterRemove` 删除规则并 `reapplyAll` 后，旧 overlay 全部残留 → 视觉上高亮不消失。
- `highlighterClearAll` 直接调 `clearNamespace` → 正常。
- 附带缺陷：每次编辑后的 debounce 重扫同样叠加一层 overlay，decoration 数量持续膨胀。
- scrollbar markers 无此问题：`setScrollbarMarkers` 按 namespace 整体替换（`handle_set_scrollbar_markers` → `set_markers`）。

## 修复方案

`applyToBuffer` 在重建装饰前，先对该 buffer 执行：

- `editor.clearNamespace(bufferId, NAMESPACE)`
- `editor.clearScrollbarMarkers(bufferId, SCROLL_NAMESPACE)`

随后正常重建。`enabled.length === 0` 分支中重复的清除调用可删除（已前置）。

## 验收标准

1. 添加高亮 A，再添加高亮 B；Remove A 后 A 的视觉高亮立即消失，B 保留。
2. 编辑缓冲区文本（触发 debounce 重扫）后高亮不叠加、不残留。
3. Remove 后滚动条标记同步消失。
4. Clear All 行为不变。
5. `tsc` 类型检查通过（如需）。

## 范围

- 仅改 `index.ts` 的 `applyToBuffer`（一处）。
- 不涉及规则持久化、匹配逻辑、命令注册。
