/* 多模态输入：粘贴 / 拖拽 / 选文件，都能变成附件随消息发出去。
 * 用法：
 *   const tray = createAttachTray({ input: "newText", tray: "newAttachTray", pick: "newAttachBtn", job: () => null });
 *   tray.files()          // [{name,path,kind,size}]
 *   tray.clear()
 * 依赖 core.js 的 $ / esc / api / toast。
 */
function createAttachTray(opts) {
  const state = { items: [] };          // {name,path,kind,size,localUrl,uploading}
  const MAX_FILES = 10;
  const MAX_SIZE = 25 * 1024 * 1024;

  const input = () => (typeof opts.input === "string" ? $(opts.input) : opts.input);
  const trayEl = () => (typeof opts.tray === "string" ? $(opts.tray) : opts.tray);
  const pickBtn = () => (typeof opts.pick === "string" ? $(opts.pick) : opts.pick);
  const jobId = () => (typeof opts.job === "function" ? opts.job() : opts.job) || "tmp";

  function render() {
    const el = trayEl();
    if (!el) return;
    if (!state.items.length) { el.classList.remove("show"); el.innerHTML = ""; return; }
    el.classList.add("show");
    el.innerHTML = state.items.map((f, i) => `
      <div class="att ${f.uploading ? "up" : ""}" title="${esc(f.name)}">
        ${f.kind === "image" && f.localUrl
          ? `<img src="${esc(f.localUrl)}" alt="">`
          : `<span class="att-ico">${f.uploading ? "⏳" : "📄"}</span>`}
        <span class="att-name">${esc(f.name)}</span>
        <button class="att-x" data-att-del="${i}" aria-label="移除">✕</button>
      </div>`).join("");
    el.querySelectorAll("[data-att-del]").forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        const i = Number(b.dataset.attDel);
        const f = state.items[i];
        if (f?.localUrl) URL.revokeObjectURL(f.localUrl);
        state.items.splice(i, 1);
        render();
      };
    });
  }

  async function addFiles(fileList) {
    const list = Array.from(fileList || []);
    if (!list.length) return;
    const room = MAX_FILES - state.items.length;
    if (room <= 0) { toast(`最多 ${MAX_FILES} 个附件`, true); return; }
    const chosen = list.slice(0, room);
    for (const raw of list.slice(room)) toast(`「${raw.name}」超出了附件上限，已跳过`, true);

    for (const file of chosen) {
      if (file.size > MAX_SIZE) { toast(`「${file.name}」超过 25MB`, true); continue; }
      const kind = /^image\//.test(file.type) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name) ? "image" : "file";
      const localUrl = kind === "image" ? URL.createObjectURL(file) : "";
      // 先乐观插进列表，让缩略图立刻出现
      const item = { name: file.name || `粘贴_${Date.now()}.png`, path: "", kind, size: file.size, localUrl, uploading: true };
      state.items.push(item);
      render();

      try {
        const fd = new FormData();
        fd.append("files", file, file.name || "pasted.png");
        const r = await fetch(`/api/upload?job=${encodeURIComponent(jobId())}`, { method: "POST", body: fd });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `上传失败 ${r.status}`);
        const saved = j.files?.[0];
        if (!saved) throw new Error("服务端没有返回文件");
        item.path = saved.path;
        item.name = saved.name || item.name;
        item.kind = saved.kind || item.kind;
        item.size = saved.size ?? item.size;
      } catch (e) {
        toast(`附件上传失败：${e.message}`, true);
        const i = state.items.indexOf(item);
        if (i >= 0) state.items.splice(i, 1);
        if (localUrl) URL.revokeObjectURL(localUrl);
      } finally {
        item.uploading = false;
        render();
      }
    }
  }

  function files() {
    return state.items.filter((f) => f.path && !f.uploading).map((f) => ({
      name: f.name, path: f.path, kind: f.kind, size: f.size,
    }));
  }

  function clear() {
    for (const f of state.items) if (f.localUrl) URL.revokeObjectURL(f.localUrl);
    state.items = [];
    render();
  }

  function bind() {
    const box = input();
    if (!box) return;
    // 1) 粘贴：截图、复制的图片、复制的文件都走这里
    box.addEventListener("paste", (e) => {
      const dt = e.clipboardData;
      if (!dt) return;
      const files = [];
      for (const item of dt.items || []) {
        if (item.kind === "file") {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        addFiles(files);
      }
      // 纯文本粘贴走浏览器默认行为
    });

    // 2) 拖拽
    const zone = box.closest(".composer, .welcome-inner") || box;
    ["dragenter", "dragover"].forEach((ev) => zone.addEventListener(ev, (e) => {
      if (!e.dataTransfer) return;
      if (![...(e.dataTransfer.types || [])].includes("Files")) return;
      e.preventDefault();
      zone.classList.add("drag-over");
    }));
    ["dragleave", "dragend"].forEach((ev) => zone.addEventListener(ev, () => zone.classList.remove("drag-over")));
    zone.addEventListener("drop", (e) => {
      if (!e.dataTransfer) return;
      const files = e.dataTransfer.files;
      if (!files || !files.length) return;
      e.preventDefault();
      zone.classList.remove("drag-over");
      addFiles(files);
    });

    // 3) 文件选择器
    const btn = pickBtn();
    if (btn) {
      const hidden = document.createElement("input");
      hidden.type = "file";
      hidden.multiple = true;
      hidden.style.display = "none";
      document.body.appendChild(hidden);
      hidden.onchange = () => { addFiles(hidden.files); hidden.value = ""; };
      btn.onclick = () => hidden.click();
    }
  }

  bind();
  return { files, clear, addFiles, render, state };
}
