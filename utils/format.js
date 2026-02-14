function escapeMarkdown(text) {
  if (!text) return '';
  // 转义 Markdown 特殊字符：_ * [ ] ( ) ~ ` > # + - = | { } . !
  return String(text).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

module.exports = {
  escapeMarkdown
};
