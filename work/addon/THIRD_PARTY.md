# 第三方组件

本安装包包含以下组件，原始许可证随组件保留：

| 组件 | 版本 | 许可与来源 |
| --- | --- | --- |
| PDF.js | 4.10.38 | Apache-2.0；https://github.com/mozilla/pdf.js；content/vendor/PDFJS-LICENSE |
| pdf-lib | 1.17.1 | MIT；https://github.com/Hopding/pdf-lib；content/vendor/PDFLIB-LICENSE.md |
| @pdf-lib/fontkit | 1.1.1 | MIT；https://github.com/Hopding/fontkit；content/vendor/FONTKIT-NOTICE.md 保留 npm 分发包的原始作者与许可说明 |
| Noto Sans SC | Google Fonts 获取的 wght 字体，静态化为 400 | SIL OFL 1.1；https://github.com/google/fonts/tree/main/ofl/notosanssc；content/vendor/FONT-OFL.txt |
| PDF.js 标准字体及 CMap | 随 PDF.js 4.10.38 | 对应目录内保留原始许可文件 |

插件自己的代码采用根目录 LICENSE。字体静态化仅为改善 PDF 兼容性；没有将字体单独出售。DeepSeek API 是用户自行配置的外部服务，未打包其客户端或任何访问密钥。

构建：Windows PowerShell 执行 work/build.ps1，将 work/addon 压缩为 XPI。
npm 锁定文件位于 work/build，字体来源与许可证见上表。旧内核不需要额外运行时；本机引擎模式由插件安装和调用隔离 Python 环境。

阅读字体在用户本机从 Windows Fonts 读取：宋体、Times New Roman；缺字时可使用已安装的 Cambria Math、Segoe UI Symbol、Segoe UI Emoji、扩展宋体。安装包和源码不包含这些系统字体文件。后备字体仅在覆盖当前所缺字符时嵌入生成的译版。包内 Noto Sans SC 及其许可证保留供兼容路径使用。

## 可选的本机引擎

BabelDOC 0.6.4 作为独立本机进程安装，项目源码和 AGPL-3.0 许可证见 https://github.com/funstory-ai/BabelDOC 。Python 包的固定版本见 engine/requirements.txt；运行环境、模型、缓存和论文不打进 XPI。MSVC运行库由隔离环境的msvc-runtime包提供，遵循其自身许可，不标注为本插件MIT代码。系统字体只从用户本机读取，不随插件分发。BabelDOC 和模型由安装程序从上游获取，其各自的许可证继续适用。

PDF.js 4.10.38 含本地文本提取补丁，说明见 content/PDFJS-PATCHES.md；Apache-2.0 许可保留，渲染代码未改。
