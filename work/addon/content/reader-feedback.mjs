// User actions depend on the failure stage, not the first matching keyword.
export function issueGuidance(issue){
 const c=issue.code;
 if(c.startsWith("layout_"))return {action:"自动重新排版",hint:"插件会重新拟合安全空间。排版失败不会重新调用翻译；可先阅读其他已完成内容。"};
 if(c==="font_missing")return {action:"重新检查本机字体",hint:"插件会按字符选择已有后备字体；这不是翻译错误，不需要重译。"};
 if(c==="source_structure"||c==="source_symbol")return {action:"自动重新识别",hint:"先重新核对原文区域和符号归属；无法确认的区域会保留原文并标记，其他内容可继续阅读。"};
 if(c==="translation_science"||c==="translation_identifier")return {action:"自动核对译文",hint:"先按原文识别材料编号、真实数值和单位，重新检查已有草稿；仍缺少科学内容时只补译受影响的完整段落。"};
 if(c.startsWith("service_"))return {action:"重试连接",hint:"服务恢复后继续已保存的进度，已完成段落不会重新翻译。"};
 return {action:"自动修复译文",hint:"先复用合格草稿，再对缺失内容进行有限补译；公式标记由插件处理，无需手动改编号。"};
}
export function completionMessage({done,total,groups,pending,saved=false,preview=false}){
 const output=preview?"已在右侧显示完成部分，标记处仍为原文；完整译版将在问题解决后保存。":saved?"已保存的译版仍可打开；本次有效译文已保存。":"有效译文已保存，完整中文 PDF 尚未生成。";
 return "未完成：已保存 "+done+" / "+total+" 段译文；"+groups+" 类问题，涉及 "+pending+" 段。"+output;
}
export function validationMessage(issues){return issues.map(i=>i.message).filter(Boolean).join("；");}
export function previewFailureMessage(issues,diagnostic=false){
 const text=validationMessage(issues)||"暂时无法生成预览。";
 if(issues.some(i=>i.stage==="translation"))return text+(diagnostic?" 右侧仅供核对译文，尚不能应用；无需调整字号或行距。":" 请先使用自动核对，已保存的草稿不会丢失。");
 return text+(diagnostic?" 红色区域显示排版冲突，当前预览不能应用。":"")+" 插件已尝试自动拟合；可以先阅读其他完成内容。";
}
