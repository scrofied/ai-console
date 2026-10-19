/* ==========================================================================
   程序化真人头像生成器
   —— 不是剪影、不是字母：每个席位根据 id 确定性生成一张"大头贴"风格的半身像
      （肤色、发型、发色、脸型、眉眼、眼镜、胡子、西装、领带、衬衫都由种子决定）。
   输出 SVG 字符串 / data URI，直接塞进 <img> 或头像圈。
   ========================================================================== */

const PORTRAIT_SKINS = [
  { base: "#f2d2b6", shade: "#d9ab8a", deep: "#b98663", ear: "#e7bd9d", lip: "#b5695f" },
  { base: "#e8bf9b", shade: "#c99a75", deep: "#a87853", ear: "#d8a884", lip: "#a85c54" },
  { base: "#d9a877", shade: "#b8895a", deep: "#8e6340", ear: "#c9986a", lip: "#96504a" },
  { base: "#b9835a", shade: "#97643f", deep: "#6f4529", ear: "#a77450", lip: "#7d3f38" },
  { base: "#8d5c3c", shade: "#6f452c", deep: "#4f2f1c", ear: "#7d5034", lip: "#5c2c26" },
];
const PORTRAIT_HAIR = [
  { main: "#2b2119", hi: "#4a3728", lo: "#171009" },
  { main: "#4a3222", hi: "#6d4a33", lo: "#2b1c11" },
  { main: "#8a6a45", hi: "#b08a5e", lo: "#5d452b" },
  { main: "#b9bcc2", hi: "#e2e5ea", lo: "#8b9098" },
  { main: "#20242b", hi: "#3a414c", lo: "#0d1013" },
];
const PORTRAIT_SUITS = [
  { main: "#1d2637", hi: "#2c3a52", lo: "#121a27" },
  { main: "#242424", hi: "#383838", lo: "#141414" },
  { main: "#3b2f2a", hi: "#54433a", lo: "#241c18" },
  { main: "#1f3330", hi: "#2f4a45", lo: "#132220" },
  { main: "#2b2438", hi: "#413659", lo: "#1a1523" },
];
const PORTRAIT_BG = [
  ["#aebfd6", "#6d84a6"],
  ["#cfc3b2", "#8f8271"],
  ["#b9c9c2", "#788f88"],
  ["#c8b8c6", "#8a7688"],
  ["#b6bcc9", "#707888"],
];

/** 稳定的 32 位 hash：同一个 id 永远得到同一张脸 */
function pfpHash(str) {
  let h = 2166136261 >>> 0;
  const s = String(str || "seat");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** 从种子派生一串可复现的随机数 */
function pfpRng(seed) {
  let x = seed || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return (x % 100000) / 100000;
  };
}

/**
 * 生成一张头像。
 * @param {string} seed  席位 id（决定长相，稳定不变）
 * @param {object} opt   { size:渲染尺寸, idSuffix:同一张脸需要多个实例时区分渐变 id }
 * @returns {string} SVG 字符串
 */
function portraitSvg(seed, opt = {}) {
  const size = opt.size || 200;
  const uid = "p" + pfpHash(seed + (opt.idSuffix || ""));
  const rnd = pfpRng(pfpHash(seed));
  const pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];

  const skin = pick(PORTRAIT_SKINS);
  const hair = pick(PORTRAIT_HAIR);
  const suit = pick(PORTRAIT_SUITS);
  const bg = pick(PORTRAIT_BG);

  const hairStyle = Math.floor(rnd() * 6);       // 0 侧分 1 短寸 2 后梳 3 卷 4 偏长 5 谢顶
  const hasGlasses = rnd() < 0.4;
  const hasBeard = rnd() < 0.3;
  const hasTie = rnd() < 0.55;
  const faceW = 44 + rnd() * 8;                  // 脸宽
  const faceH = 55 + rnd() * 6;                  // 脸高
  const browTilt = (rnd() - 0.5) * 4;
  const eyeY = 84;
  const mouthW = 12 + rnd() * 5;
  const older = rnd() < 0.35;                    // 加点法令纹，显得像真人

  const cx = 100;
  const headCY = 78;

  // —— 发型：不同样式画不同的头顶轮廓
  const hairFront = (() => {
    switch (hairStyle) {
      case 0: return `<path d="M52 74c-3-30 20-46 48-46s51 16 48 46c-3-14-10-22-18-26-12 8-38 12-52 6-12 4-22 10-26 20z" fill="url(#${uid}h)"/>`;
      case 1: return `<path d="M52 72c-2-28 22-44 48-44s50 16 48 44c-5-16-16-24-30-25-10 6-26 8-38 4-14 3-24 10-28 21z" fill="url(#${uid}h)"/>`;
      case 2: return `<path d="M51 70c-4-32 22-50 49-50s53 18 49 50c-4-20-12-30-22-34-14 10-42 12-54 4-12 6-19 16-22 30z" fill="url(#${uid}h)"/>`;
      case 3: return `<path d="M48 76c-6-36 24-54 52-54s58 18 52 54c-4-10-4-20-2-26-10 14-30 18-50 14-16-3-28 2-38 12-4 6-6 10-8 16z" fill="url(#${uid}h)"/>` +
        `<circle cx="70" cy="52" r="9" fill="url(#${uid}h)"/><circle cx="128" cy="50" r="10" fill="url(#${uid}h)"/><circle cx="98" cy="42" r="11" fill="url(#${uid}h)"/>`;
      case 4: return `<path d="M50 78c-6-34 22-52 50-52s56 18 50 52c-2-12-6-22-10-28-6 10-18 14-40 14-20 0-34-4-40-14-4 6-8 16-10 28z" fill="url(#${uid}h)"/>` +
        `<path d="M50 74c-4 20-2 34 2 42 4-10 4-24 2-38z" fill="url(#${uid}h)"/><path d="M150 74c4 20 2 34-2 42-4-10-4-24-2-38z" fill="url(#${uid}h)"/>`;
      default: return `<path d="M58 74c-2-16 4-30 14-36 8 6 22 8 34 6 10 4 18 14 18 28-6-10-14-14-22-16-14 6-30 6-44 0-2 6 0 12 0 18z" fill="url(#${uid}h)" opacity=".9"/>`;
    }
  })();

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="${size}" height="${size}" role="img">
  <defs>
    <linearGradient id="${uid}bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${bg[0]}"/><stop offset="1" stop-color="${bg[1]}"/>
    </linearGradient>
    <radialGradient id="${uid}vig" cx="50%" cy="38%" r="72%">
      <stop offset="52%" stop-color="rgba(255,255,255,.16)"/>
      <stop offset="100%" stop-color="rgba(0,0,0,.34)"/>
    </radialGradient>
    <linearGradient id="${uid}skin" x1="0.25" y1="0" x2="0.8" y2="1">
      <stop offset="0" stop-color="${lighten(skin.base, 10)}"/>
      <stop offset="55%" stop-color="${skin.base}"/>
      <stop offset="100%" stop-color="${skin.shade}"/>
    </linearGradient>
    <linearGradient id="${uid}h" x1="0.2" y1="0" x2="0.8" y2="1">
      <stop offset="0" stop-color="${hair.hi}"/>
      <stop offset="45%" stop-color="${hair.main}"/>
      <stop offset="100%" stop-color="${hair.lo}"/>
    </linearGradient>
    <linearGradient id="${uid}s" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${suit.hi}"/>
      <stop offset="55%" stop-color="${suit.main}"/>
      <stop offset="100%" stop-color="${suit.lo}"/>
    </linearGradient>
    <linearGradient id="${uid}neck" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${skin.deep}"/><stop offset="100%" stop-color="${skin.shade}"/>
    </linearGradient>
    <filter id="${uid}soft" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="2.2"/>
    </filter>
    <filter id="${uid}grain">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" result="n"/>
      <feColorMatrix in="n" type="saturate" values="0"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.055"/></feComponentTransfer>
    </filter>
  </defs>

  <!-- 影棚背景 -->
  <rect width="200" height="200" fill="url(#${uid}bg)"/>
  <rect width="200" height="200" fill="url(#${uid}vig)"/>

  <!-- 肩膀 / 西装 -->
  <path d="M12 200c2-30 16-48 40-58l48-16 48 16c24 10 38 28 40 58z" fill="url(#${uid}s)"/>
  <!-- 西装驳领 -->
  <path d="M70 132l30 26-14 42-30-58z" fill="rgba(255,255,255,.10)"/>
  <path d="M130 132l-30 26 14 42 30-58z" fill="rgba(0,0,0,.22)"/>
  <!-- 衬衫 -->
  <path d="M84 128l16 12 16-12 6 72H78z" fill="#f4f6f9"/>
  <path d="M84 128l16 12v72H78z" fill="#e2e7ee"/>
  ${hasTie ? `<path d="M100 142l9 12-9 44-9-44z" fill="${suit.hi}"/>
    <path d="M100 142l9 12-9 6-9-6z" fill="${suit.lo}"/>` : ""}

  <!-- 脖子 -->
  <path d="M86 112h28v26c0 8-28 8-28 0z" fill="url(#${uid}neck)"/>
  <ellipse cx="100" cy="140" rx="20" ry="7" fill="${skin.deep}" opacity=".25" filter="url(#${uid}soft)"/>

  <!-- 耳朵 -->
  <ellipse cx="${cx - faceW + 4}" cy="90" rx="6" ry="10" fill="${skin.ear}"/>
  <ellipse cx="${cx + faceW - 4}" cy="90" rx="6" ry="10" fill="${skin.ear}"/>

  <!-- 脸 -->
  <path d="M${cx - faceW} ${headCY + 6}
    c0-32 14-52 ${faceW}-52 30 0 ${faceW} 20 ${faceW} 52
    c0 30-14 48-${faceW - 4} 60-${faceW - 10}-12-${faceW - 4}-30-${faceW - 4}-60z"
    fill="url(#${uid}skin)"/>
  <!-- 颧骨 / 下颌阴影 -->
  <path d="M${cx + 22} 92c6 18 2 34-10 46-6-14-8-30-4-46z" fill="${skin.shade}" opacity=".38" filter="url(#${uid}soft)"/>
  <path d="M${cx - 26} 96c-4 14 0 28 8 40-6-12-8-26-6-40z" fill="${skin.shade}" opacity=".26" filter="url(#${uid}soft)"/>

  ${hairFront}

  <!-- 眉毛 -->
  <path d="M${cx - 30} ${eyeY - 14 + browTilt}q14-7 26-2" stroke="${hair.main}" stroke-width="5"
    stroke-linecap="round" fill="none" opacity=".92"/>
  <path d="M${cx + 30} ${eyeY - 14 + browTilt}q-14-7-26-2" stroke="${hair.main}" stroke-width="5"
    stroke-linecap="round" fill="none" opacity=".92"/>

  <!-- 眼睛 -->
  ${[cx - 18, cx + 18].map((ex) => `
    <ellipse cx="${ex}" cy="${eyeY}" rx="9.5" ry="6" fill="#fbfaf8"/>
    <circle cx="${ex}" cy="${eyeY}" r="5.4" fill="#4a3a2e"/>
    <circle cx="${ex}" cy="${eyeY}" r="2.5" fill="#140f0b"/>
    <circle cx="${ex - 2.1}" cy="${eyeY - 2.2}" r="1.7" fill="#fff" opacity=".92"/>
    <path d="M${ex - 10} ${eyeY - 6}q10-5 20 0" stroke="${hair.lo}" stroke-width="2.4" fill="none" opacity=".55"/>
  `).join("")}

  <!-- 鼻子 -->
  <path d="M${cx} ${eyeY + 4}c-3 8-6 13-4 16 2 2 6 2 8 0" stroke="${skin.shade}" stroke-width="3.2"
    fill="none" stroke-linecap="round" opacity=".8"/>
  <ellipse cx="${cx}" cy="${eyeY + 22}" rx="7" ry="3" fill="${skin.deep}" opacity=".22" filter="url(#${uid}soft)"/>

  <!-- 嘴 -->
  <path d="M${cx - mouthW / 2} ${eyeY + 30}q${mouthW / 2} ${6 + rnd() * 4} ${mouthW / 2} 0" stroke="${skin.lip}"
    stroke-width="3.4" fill="none" stroke-linecap="round"/>
  <path d="M${cx - mouthW / 2 + 2} ${eyeY + 31}q${mouthW / 2 - 2} ${-3} ${mouthW / 2 - 2} 0" stroke="${lighten(skin.lip, 18)}"
    stroke-width="2" fill="none" stroke-linecap="round" opacity=".7"/>

  ${older ? `<path d="M${cx - 22} ${eyeY + 16}q-6 8-2 16" stroke="${skin.shade}" stroke-width="2" fill="none" opacity=".35"/>
    <path d="M${cx + 22} ${eyeY + 16}q6 8 2 16" stroke="${skin.shade}" stroke-width="2" fill="none" opacity=".35"/>` : ""}

  ${hasBeard ? `<path d="M${cx - 30} ${eyeY + 18}c0 26 12 40 30 44 18-4 30-18 30-44-6 16-18 24-30 24s-24-8-30-24z"
    fill="${hair.main}" opacity=".55" filter="url(#${uid}soft)"/>` : ""}

  ${hasGlasses ? `
    <g fill="none" stroke="#3a3f47" stroke-width="2.6" opacity=".9">
      <rect x="${cx - 33}" y="${eyeY - 12}" width="28" height="21" rx="7" fill="rgba(255,255,255,.10)"/>
      <rect x="${cx + 5}" y="${eyeY - 12}" width="28" height="21" rx="7" fill="rgba(255,255,255,.10)"/>
      <path d="M${cx - 5} ${eyeY - 2}h10"/>
      <path d="M${cx - 33} ${eyeY - 4}l-10 4"/>
      <path d="M${cx + 33} ${eyeY - 4}l10 4"/>
    </g>` : ""}

  <!-- 边缘光 + 颗粒：让画面像照片而不是纯色块 -->
  <path d="M0 0h200v200H0z" fill="url(#${uid}vig)" opacity=".55"/>
  <rect width="200" height="200" filter="url(#${uid}grain)" opacity=".5"/>
</svg>`;
}

/** 把颜色提亮/压暗一点（参数取 -100..100） */
function lighten(hex, amt) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex));
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(((n >> 16) & 255) + amt * 2.55);
  const g = clamp(((n >> 8) & 255) + amt * 2.55);
  const b = clamp((n & 255) + amt * 2.55);
  return "#" + ((r << 16) | (g << 8) | b).toString(16).padStart(6, "0");
}

/** 直接给 <img src> 用的 data URI */
function portraitDataUri(seed, opt = {}) {
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(portraitSvg(seed, opt));
}
