export function typographyEditorMarkup() {
  const familyOptions = [
    ["system", "系统默认"],
    ["modern", "现代黑体"],
    ["serif", "中文宋体"],
    ["rounded", "圆体"],
    ["mono", "等宽字体"],
  ];
  return `
      <div class="typography-heading">
        <strong>排版设置</strong>
        <span class="save-state" data-save-state>自动保存</span>
      </div>
      <div class="type-controls">
        <label class="control-field">
          <span>字体</span>
          <select data-font-family aria-label="字体">
            ${familyOptions.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}
          </select>
        </label>
        <label class="control-field">
          <span class="size-label">字号 <output data-font-size-output>24 px</output></span>
          <span class="size-control">
            <input type="range" min="10" max="64" step="1" value="24" data-font-size aria-label="字号" />
            <output class="size-value" data-font-size-box>24</output>
          </span>
        </label>
        <div class="inline-control-groups">
          <div class="control-group">
            <span>格式</span>
            <div class="segmented-control">
              <button class="style-button" type="button" data-format="bold" aria-pressed="false">加粗</button>
            </div>
          </div>
          <div class="control-group">
            <span>对齐</span>
            <div class="segmented-control">
              <button class="style-button" type="button" data-align="left" aria-pressed="false">左</button>
              <button class="style-button" type="button" data-align="center" aria-pressed="false">中</button>
              <button class="style-button" type="button" data-align="right" aria-pressed="false">右</button>
            </div>
          </div>
        </div>
        <div class="render-controls">
          <div class="render-heading">
            <strong>渲染效果</strong>
            <span>颜色与描边</span>
          </div>
          <label class="control-field color-field">
            <span>文字颜色</span>
            <span class="color-control">
              <input type="color" value="#ffffff" data-text-color aria-label="文字颜色" />
              <code data-text-color-value>#ffffff</code>
            </span>
          </label>
          <label class="checkbox-control">
            <input type="checkbox" data-outline-enabled />
            <span>启用文字描边</span>
          </label>
          <div class="outline-controls" data-outline-controls>
            <label class="control-field color-field">
              <span>描边颜色</span>
              <span class="color-control">
                <input type="color" value="#050505" data-outline-color aria-label="描边颜色" />
                <code data-outline-color-value>#050505</code>
              </span>
            </label>
            <label class="control-field">
              <span class="size-label">描边宽度 <output data-outline-width-output>1 px</output></span>
              <span class="size-control">
                <input type="range" min="1" max="8" step="1" value="1" data-outline-width aria-label="描边宽度" />
                <output class="size-value" data-outline-width-box>1</output>
              </span>
            </label>
          </div>
        </div>
      </div>
    `;

}
