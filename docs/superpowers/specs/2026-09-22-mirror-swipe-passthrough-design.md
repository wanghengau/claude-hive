# iPhone 镜像小窗:⌃+双指上划透传(回主屏)

- **日期**: 2026-09-22
- **状态**: 已批准(brainstorming 产出),待实现
- **作者**: brainstorming 协作产出

---

## 1. 背景与目标

网页侧栏的 iPhone 镜像小窗(`MirrorRow`)目前是**纯投影**:`getDisplayMedia` 捕获 macOS「iPhone 镜像」窗口,只能看不能操作。用户希望在小窗内直接触发 iPhone 的上划手势(回主屏/多任务),不必切到 Mac 上的镜像窗口。

**手势形态(用户定案)**:鼠标悬停在小窗内,**按住 ⌃(Control)+ 双指上划** → iPhone 执行上划。其余现有交互(裸滚动缩放、拖动平移、双击复位、⌘ 拖拽排序)**一律不变**。

**范围**:只做「上划」一个动作(单动作透传)。点按/横划/下划等通用遥控不在本期(非目标,见 §9)。

## 2. 关键架构事实

`getDisplayMedia` 捕获流是**单向只读**的——投影画面没有任何反向输入通道。手势透传必须走旁路:

```
⌃+双指上划(wheel: ctrlKey=true, deltaY>0)
  → MirrorRow wheel 拦截(不缩放、不冒泡),momentum 聚合去抖
  → POST /api/mirror/swipe-up(同源)
  → server.ts 新路由(必须注册在 handleProxy 之前——已知陷阱)
  → mirror-control.ts: JXA 定位「iPhone 镜像」窗口 bounds
     → CGEvent 合成「窗口下部 → 中上部」拖拽,CGEventPostToPid 注入
  → macOS Continuity 把拖拽转发给 iPhone → 回主屏
```

## 3. 现状(资产盘点)

- `web/src/components/iphone-mirror-card.tsx`:`MirrorRow` 画面区已有手势——wheel 缩放(原生 addEventListener, passive:false,锚点=光标)、pointer 拖动平移、双击复位;流由 `use-mirror-stream.ts` 在列表外持有。
- `server/src/server.ts`:HTTP 路由层,`/api/analyze/interpret` 等端点;**POST 路由必须注册在 `handleProxy` 之前**(否则被代理吞掉)。
- 服务端托管 web dist(4000 端口),前端调 `/api/*` 同源,无 CORS 问题。

## 4. 组件设计

### 4.1 前端手势(`iphone-mirror-card.tsx`)

在现有 wheel handler **最前**加分支:

- 进入条件:`e.ctrlKey && e.deltaY > 0`(假设系统「自然滚动」开启:双指上划 → deltaY>0。方向假设不成立时翻转一个模块级常量,一行修正)。
- 命中后:`preventDefault + stopPropagation`(不缩放、不滚会话列表)。
- **momentum 聚合**:ctrl 按住期间累计 `deltaY`,超过阈值(初值 120)触发一次 `POST /api/mirror/swipe-up`,随后进入 800ms 冷却(触摸板惯性会连发几十个 wheel 事件,必须防连发)。冷却结束或 ctrl 释放后重新累计。
- 触发反馈:iPhone 画面自身的变化即反馈,不加额外 UI;请求失败时标题条短暂显示错误(见 §6)。
- 裸滚动(deltaY 方向缩放、无 ctrl)逻辑零改动。

### 4.2 服务端路由(`server.ts`)

- `POST /api/mirror/swipe-up` → 调 `mirror-control.ts` → 返回 `{ok:true}` 或 `{ok:false, reason:"<机器可读码>"}`。
- 注册位置:与其他 `/api/*` 一样,**在 `handleProxy` 之前**。
- 仅本机使用,不做鉴权(与现有 `/api/analyze` 一致);但只接受 POST、路径精确匹配。

### 4.3 注入执行(`server/src/mirror-control.ts` 新文件)

用 `execFile('osascript', ['-l','JavaScript', ...])` 跑 JXA 脚本(系统自带,零外部依赖),两步:

1. **定位窗口**:JXA `ObjC.import('CoreGraphics')` 调 `CGWindowListCopyWindowInfo` 取窗口列表,匹配 owner 进程名 `iPhone Mirroring`(Continuity app,`com.apple.ScreenContinuity`)取窗口 bounds。进程名/标题匹配串以 spike 实测为准。
2. **合成拖拽**:`CGEventCreateMouseEvent` + `CGEventPostToPid`(leftDown @ (cx, bounds 下部 1/6 处) → 若干 move 插值 → leftUp @ (cx, bounds 上部 1/3 处))。`PostToPid` 定向投递,不移动用户真实光标。

失败模式(返回结构化 reason):

| 场景 | reason 码 |
|:--|:--|
| 找不到「iPhone 镜像」窗口(iPhone 未连接/未开镜像) | `window-not-found` |
| osascript 非零退出(含辅助功能未授权) | `inject-failed`(附 stderr 摘要) |

## 5. 关键决策记录

1. **⌃+wheel 而非鼠标拖拽上划**:双指上划是 wheel 事件,与 pointer 拖动平移天然分通道,零冲突;ctrl 修饰确保与裸滚动缩放零冲突。用户定案。
2. **CGEventPostToPid 而非全局注入(cliclick/CGEventPost)**:定向投递不抢真实鼠标;cliclick 方案否决(外部依赖 + 动真实光标)。
3. **单动作而非通用遥控**:YAGNI——先做上划,手势协议等真有需求再泛化。
4. **momentum 聚合 + 冷却**:触摸板惯性 wheel 连发是必踩坑,首版就要防。

## 6. 错误处理与权限

- **辅助功能授权**:CGEvent 注入需要。首次调用时 macOS 弹授权(node/终端加入辅助功能);未授权 → osascript 失败 → `inject-failed`,前端标题条显示「透传失败:需辅助功能授权」2 秒后淡出。不静默吞错。
- 前端 fetch 失败(服务未起)同路径提示。
- 服务端不重试:上划是即时的,重试旧手势无意义。

## 7. 测试策略

- **单测(前端,vitest+jsdom)**:ctrl+上划 wheel → fetch 恰好一次、且不触发缩放;momentum 连发只发一次;裸滚动缩放行为回归不变;`deltaY<0` + ctrl 不触发。
- **单测(服务端,vitest)**:路由顺序(POST 在 handleProxy 前);mirror-control 对 execFile 的 mock:成功/`window-not-found`/`inject-failed` 三分支。
- **Spike(实现第一步,throwaway 脚本)**:在真机验证 ①窗口定位串 ②CGEventPostToPid 桥接是否可行 ③Continuity 是否吃合成拖拽(iPhone 真的上划)④授权流程。**spike 不通则换方案 C(swiftc 编译内置小工具)再继续——这是写实现计划的先决输入。**
- **e2e 演示(主会话,playwright MCP)**:canvas 假流注入共享(既有手法)挂小窗,stub `window.fetch` 断言透传调用;真机注入由用户人工验收。

## 8. 风险

- **pinch 歧义**:macOS 触摸板「捏合」在浏览器表现为 `ctrlKey=true` 的 wheel——捏合缩小(deltaY>0)会误触发一次上划。缓解:阈值+冷却;若实际使用困扰,后续迭代(如 Safari gesture 事件区分)。首版接受。
- **JXA 桥接 CGEventPostToPid 的类型坑**:pid_t 等参数桥接可能失败 → spike 前置,失败即切方案 C。
- **窗口匹配脆弱**:系统更新改进程名/标题 → `window-not-found` 显式报错,维护点单一(const 匹配串)。

## 9. 非目标

- 点按、横划、下划等其它手势透传(通用遥控)
- 上划的「短划=回主屏 / 长划停顿=多任务」区分(首版固定为回主屏式短上划)
- Windows/Linux 平台支持(macOS 专属)
