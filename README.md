# Chrome Proxy Switcher

一个基于 Chrome Manifest V3 的代理切换扩展，用于：

- 快速开启/关闭 HTTP(S) 代理
- 在多个代理配置（Profile）之间快速切换
- 为每个 Profile 配置多条 URL 规则，按命中规则转发

## 功能概览

- Popup 一键切换当前激活的代理配置
- Options 页面左右布局：
  - 左侧：Profile 列表（新增、删除、导入、导出）
  - 右侧：Profile 详情（重命名、规则编辑）
- 每条规则支持：
  - `urlPattern`（PAC 的 `shExpMatch`）
  - `protocol`（HTTP / HTTPS）
  - `domain`
  - `port`
- `direct` 配置不可编辑、不可删除
- 非 `direct` Profile 至少保留 1 条规则
- JSON 导出仅包含非 `direct` Profile；支持跨电脑增量导入（按 `id` 或名称合并）
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
      "name": "Direct (Off)",
      "mode": "direct",
      "rules": []
    },
    {
      "id": "sample-http",
      "name": "Sample HTTP Proxy",
      "mode": "fixed",
      "rules": [
        {
          "urlPattern": "*://*/*",
          "protocol": "HTTP",
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
  2. 按 Profile 生成 PAC 脚本
  3. 调用 `chrome.proxy.settings.set` 应用为 `pac_script`（或 `direct`）
- 命中规则时返回对应代理；未命中返回 `DIRECT`

## 导入 / 导出（JSON）

- 入口：Options 页面左侧工具栏
  - 导出：点击“导出 JSON”，会下载当前全部 Profile 配置
  - 导入：点击“导入 JSON”，选择导出的 JSON 文件
- 导入策略为“增量合并”：
  - 先按 `id` 匹配，匹配到则更新该 Profile
  - 未按 `id` 匹配到时，按名称（不区分大小写）匹配并更新
  - 两者都不匹配则新增 Profile
  - `direct` 配置会被跳过，不会被导入覆盖
- 支持两种导入格式：
  1. 完整对象：`{ schemaVersion, activeProfileId, profiles: [...] }`
  2. 纯数组：`[ ...profiles ]`

## 注意事项

- 切换代理后，已打开网页通常需要刷新，新的请求才会按新规则走代理。
- 若 Profile 规则未配置完整（如缺少 `domain/port`），会被视为无效规则。
- 代理是否可达取决于你填写的目标代理服务本身。

## 后续可扩展

- 规则排序与优先级可视化
- 规则命中调试面板
- 配置校验与错误提示增强
