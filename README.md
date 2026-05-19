# Chrome Proxy Switcher

一个基于 Chrome Manifest V3 的代理切换扩展，用于：

- 快速开启/关闭 HTTP(S) 代理
- 在多个代理配置（Profile）之间快速切换
- 为每个 Profile 配置多条 URL 规则，按命中规则转发

## 功能概览

- Popup 一键切换当前激活的代理配置
- Popup 提供 `Debug` 按钮，可直接展开 Side Panel 调试面板
- Options 页面左右布局：
  - 左侧：Profile 列表（新增、删除、导入、导出）
  - 右侧：Profile 详情（重命名、规则编辑）
- Side Panel：查看当前生效代理状态、PAC 内容和 URL 命中测试
- 每条规则支持：
  - `matchType`（`urlPattern` / `host`）
  - `urlPattern`（PAC 的 `shExpMatch`）
  - `host`（命中根域和任意子域，忽略 protocol/path）
  - `domain`
  - `port`
- `System Proxy` 配置不可编辑、不可删除，会跟随系统代理（如 ClashX）
- 非 `System Proxy` Profile 至少保留 1 条规则
- JSON 导出仅包含非 `System Proxy` Profile；支持跨电脑增量导入（按 `id` 或名称合并）
- 兼容旧配置结构（自动迁移旧字段）

## 项目结构

- `manifest.json`：扩展声明（MV3）
- `src/background.js`：Service Worker，代理应用与 PAC 生成
- `src/popup.html` / `src/popup.js` / `src/popup.css`：快速切换面板
- `src/options.html` / `src/options.js` / `src/options.css`：配置管理页面

## 本地加载（开发）

1. 打开 Chrome，进入 `chrome://extensions/`
2. 开启右上角“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择本项目根目录

修改代码后，在扩展管理页点击“重新加载”即可生效。

## 配置模型（storage）

扩展使用 `chrome.storage.sync`，键名：`proxySwitcherState`。

示例：

```json
{
  "activeProfileId": "sample-http",
  "profiles": [
    {
      "id": "direct",
      "name": "System Proxy",
      "mode": "system",
      "rules": []
    },
    {
      "id": "sample-http",
      "name": "Sample HTTP Proxy",
      "mode": "fixed",
      "rules": [
        {
          "urlPattern": "*://*/*",
          "domain": "127.0.0.1",
          "port": "8080"
        }
      ]
    }
  ]
}
```

## 工作机制

- 切换 Profile 时，`background.js` 会：
  1. 读取当前状态
  2. 若为 `System Proxy`，清除扩展设置，让 Chrome 回退到系统代理
  3. 若为自定义 Profile，按规则生成 PAC 脚本并调用 `chrome.proxy.settings.set`
- 命中规则时返回对应代理；未命中返回 `DIRECT`
- `host` 模式会匹配 `example.com` 以及所有 `*.example.com`，不区分协议和路径
- 代理地址默认按 HTTP 代理处理，规则本身不再区分代理协议

## 导入 / 导出（JSON）

- 入口：Options 页面左侧工具栏
  - 导出：点击“导出 JSON”，会下载当前全部 Profile 配置
  - 导入：点击“导入 JSON”，选择导出的 JSON 文件
- 导入策略为“增量合并”：
  - 先按 `id` 匹配，匹配到则更新该 Profile
  - 未按 `id` 匹配到时，按名称（不区分大小写）匹配并更新
  - 两者都不匹配则新增 Profile
  - `System Proxy` / 旧版 `direct` 配置会被跳过，不会被导入覆盖
- 支持两种导入格式：
  1. 完整对象：`{ schemaVersion, activeProfileId, profiles: [...] }`
  2. 纯数组：`[ ...profiles ]`

## 注意事项

- 切换代理后，已打开网页通常需要刷新，新的请求才会按新规则走代理。
- 选择 `System Proxy` 时，Chrome 会回退到系统代理，因此可与 ClashX 一起使用。
- 若 Profile 规则未配置完整（如缺少 `domain/port`），会被视为无效规则。
- 代理是否可达取决于你填写的目标代理服务本身。

## 调试代理

- 点击 Popup 里的 `Debug` 按钮，会展开 Side Panel 调试面板。
- Side Panel 可查看：
  - 当前已激活的 Profile
  - `chrome.proxy.settings.get` 读到的当前设置
  - 当前生效的 PAC 脚本
  - 针对任意 URL 的本地命中推演结果
- “测试命中”不会真的发起网络请求，而是按当前规则解释该 URL 会命中哪条规则，或为什么未命中。
- 若要查看 Service Worker 日志，可在 `chrome://extensions/` 打开本扩展的“Service Worker”检查页面。
- 若要抓真实网络层行为，可配合 Chrome DevTools 的 Network 面板，或使用 `chrome://net-export/` 导出网络日志进一步分析。

## 后续可扩展

- 规则排序与优先级可视化
- 规则命中调试面板
- 配置校验与错误提示增强
