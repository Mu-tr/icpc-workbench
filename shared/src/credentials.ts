/**
 * 平台凭据表单的字段定义（跨端共享真相）。
 *
 * 为什么放在 shared：表单渲染在 client（Settings 页），而「单字段合并保存」的校验
 * 在 server（POST /api/settings/cookies 的 cookieFields 分支）——两端必须用同一份
 * 字段表，否则客户端改名、服务端拒绝或错位都会静默写出错误的 Cookie 头。
 */

// 仅类型引用：index.ts 反向 re-export 本模块，用 import type 避免运行时循环
import type { PlatformId } from './index.ts';

/** 单个凭据字段（对应设置页的一个输入框） */
export interface CookieFieldDef {
  /** 表单内部 key（与 cookieName 分开，允许同平台多项同名的场景） */
  key: string;
  /** 写入 Cookie 头时使用的名字 */
  cookieName: string;
  /** 输入框上方的静态说明（Cookie 名称 + 获取方式）；缺省时不显示标签行 */
  label?: string;
  /** 空输入框时的占位提示 */
  placeholder?: string;
  /** 是否用密码框渲染（长凭据遮蔽显示） */
  password?: boolean;
  /**
   * 透传模式：输入整段 Cookie 头原样使用，不加 `name=` 前缀，
   * 容忍粘贴时带上 "Cookie: " 前缀（自动剥掉）。
   * 用于会话名不固定、或值本身可能含特殊字符的平台。
   */
  raw?: boolean;
  /**
   * 「仅作为配置项保存、不写入 Cookie 头」的字段（如 QOJ 需复刻的浏览器 User-Agent）。
   * 这类字段由适配器按 `opts.<key>` 单独注入，见 CREDENTIAL_UA_FIELDS。
   */
  configOnly?: boolean;
}

/**
 * 需配置凭据的平台字段表。
 * 未在此表中的平台（纯公开 API 的 codeforces/atcoder/nowcoder）无需 Cookie。
 *
 * 注意：QOJ 的 cf_clearance 与浏览器/IP 绑定，除字段本身外还需用户填「浏览器 UA」
 * （见 CREDENTIAL_UA_FIELDS），否则同一凭据在服务端请求里必然被判失效。
 */
export const COOKIE_FIELDS: Partial<Record<PlatformId, CookieFieldDef[]>> = {
  luogu: [
    { key: 'uid', cookieName: '_uid', label: '用户 uid', placeholder: '粘贴 _uid 的值' },
    { key: 'clientId', cookieName: '__client_id', label: '登录令牌', placeholder: '粘贴 __client_id 的值', password: true },
  ],
  daimayuan: [
    { key: 'sid', cookieName: 'sid', label: '登录会话（仅需此项）', placeholder: '粘贴 sid 的值', password: true },
  ],
  leetcode: [
    { key: 'session', cookieName: 'LEETCODE_SESSION', label: '登录会话', placeholder: '粘贴 LEETCODE_SESSION 的值', password: true },
    { key: 'csrftoken', cookieName: 'csrftoken', label: 'CSRF 令牌', placeholder: '粘贴 csrftoken 的值' },
  ],
  // 计蒜客：登录态分散在 s 与 JSKUSS 两项会话 Cookie（实测站点共 4 项：acw_tc 为 CDN 项、
  // XSRF-TOKEN 供 POST 使用，均不需要）；两项都建议填写，校验不过通常是缺 JSKUSS
  jisuanke: [
    { key: 's', cookieName: 's', label: '会话（必需）', placeholder: '粘贴 s 的值', password: true, raw: true },
    { key: 'jskuss', cookieName: 'JSKUSS', label: '登录会话（必需）', placeholder: '粘贴 JSKUSS 的值', password: true, raw: true },
  ],
  // QOJ：登录会话 UOJSESSID 为必需；站点前置 Cloudflare 托管挑战，
  // cf_clearance 为浏览器签发的通行凭据（约 30 分钟有效且与浏览器 UA/IP 绑定），
  // 值较长且含特殊字符，按整段粘贴处理；被挑战时还必须配套填写同一浏览器的 UA。
  // QOJ：**两个字段即够，且都不可省**（2026-09 逐项实测）：
  //  ① 整段 Cookie —— 必须含 cf_clearance（Cloudflare 通行凭据，逐字节与签发浏览器绑定），
  //     同时含 UOJSESSID（登录会话）。缺 cf_clearance → 被挑战；缺 UOJSESSID → 302 跳登录。
  //     OptanonConsent / uoj_locale / uoj_remember_token / uoj_username 等展示项实测无影响，不必复制。
  //  ② 浏览器 User-Agent —— 缺它时 cf_clearance 必然失效（实测：不带 UA 100% 被 Cloudflare 拦截）。
  // 因此不再单列 UOJSESSID 输入框：整段粘贴已包含它，单列只会造成「到底要不要都填」的困惑。
  qoj: [
    { key: 'clearance', cookieName: 'cf_clearance', label: 'qoj.ac 完整 Cookie（必需）', placeholder: 'F12 → Network → 任意 qoj.ac 请求 → Request Headers 里 Cookie 的整段值（含 cf_clearance 与 UOJSESSID）', password: true, raw: true },
    { key: 'ua', cookieName: '__ua', label: '浏览器 User-Agent（必需）', placeholder: '在 qoj.ac 页 Console 输入 navigator.userAgent 回车，整行粘贴', configOnly: true },
  ],
};

/** 凭据字段表中「不写入 Cookie 头、而是作为请求头单独注入」的字段（如 QOJ 需复刻浏览器 UA） */
export const CREDENTIAL_UA_FIELDS: Partial<Record<PlatformId, string>> = {
  qoj: 'ua',
};

/** 平台字段定义（无则该平台不需要 Cookie） */
export function cookieFieldsOf(platform: PlatformId): CookieFieldDef[] {
  return COOKIE_FIELDS[platform] ?? [];
}

/** 写入 Cookie 头的字段（排除 UA 等 configOnly 项） */
export function cookieOnlyFieldsOf(platform: PlatformId): CookieFieldDef[] {
  return cookieFieldsOf(platform).filter((f) => f.configOnly !== true);
}

/** 从 Cookie 头按名取出单项**裸值**（含 = 的整段头按名提取，裸值原样返回） */
export function cookieFieldValue(header: string, name: string): string {
  const s = header.trim();
  if (!s) return '';
  if (!s.includes('=')) return s;
  const m = new RegExp(`(?:^|;)\\s*${name}=([^;\\s]+)`).exec(s);
  return m ? m[1] : '';
}

/**
 * 单个字段值拼装为 Cookie 头片段（尊重 raw 与 configOnly 语义；空值→空串）。
 *
 * raw 字段的两类输入都要正确：
 * - 裸值（如 `raw-sid`）→ 补名字前缀 `sid=raw-sid`
 * - 整段 Cookie 头（如 `Cookie: sid=raw-sid; x=1`）→ 先剥 `Cookie: ` 前缀；
 *   仅含本字段一项时取该值，含多项时原样保留（透传语义）。
 */
export function buildCookieItem(def: CookieFieldDef, value: string): string {
  const raw = value.trim();
  if (!raw) return '';
  if (def.configOnly) return raw; // 非 Cookie 项（如浏览器 UA）由适配器单独注入
  const stripped = raw.replace(/^cookie:\s*/i, '');
  if (!def.raw) {
    const m = new RegExp(`(?:^|;)\\s*${def.cookieName}=([^;\\s]+)`).exec(stripped);
    const val = m ? m[1] : stripped.includes(';') ? '' : stripped;
    return val ? `${def.cookieName}=${val}` : '';
  }
  const parts = stripped.split(';').map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) {
    const only = parts[0] ?? '';
    if (!only.includes('=')) return `${def.cookieName}=${only}`;
    const eq = only.indexOf('=');
    return `${only.slice(0, eq)}=${only.slice(eq + 1)}`;
  }
  return parts.join('; ');
}

/**
 * 单字段合并：只更新本次显式修改的字段，其余字段保留已保存的值。
 *
 * 修复缺陷：此前前端把「若干输入框」整体拼装成 Cookie 头后整条覆盖保存，
 * 于是「另一框留空」被理解为「删除该项」——想补填 cf_clearance 就必须把
 * UOJSESSID 一起重填，否则会话被清空、平台随即显示未连接。
 *
 * @param storedHeader 已保存的 Cookie 头（无则空串）
 * @param defs         参与 Cookie 头的字段定义
 * @param patches      本次显式修改的字段（key → 新值；空串 = 显式清空该项）
 */
export function mergeCookieFields(
  storedHeader: string,
  defs: readonly CookieFieldDef[],
  patches: Record<string, string>,
): string {
  const out: string[] = [];
  for (const def of defs) {
    // configOnly 字段（浏览器 UA）不属于 Cookie 头，由适配器单独注入；跳过以免被拼进来
    if (def.configOnly) continue;
    const patch = patches[def.key];
    if (patch !== undefined) {
      const item = buildCookieItem(def, patch);
      if (item) out.push(item);
      continue;
    }
    // 未修改：保留已保存的值。
    // raw 字段保存的就是**整段 Cookie 头**（含多项），必须原样透传——
    // 若走 buildCookieItem 会把它按 `name=value` 重新解析，丢掉第二项起的内容
    // （历史缺陷：只补填 UA 时 "cf_clearance=X; UOJSESSID=Y" 被截断成 "cf_clearance=X"，
    //  登录态随之失效，平台显示未连接）。
    if (def.raw) {
      const kept = storedHeader.trim();
      if (kept) out.push(kept);
      continue;
    }
    const kept = cookieFieldValue(storedHeader, def.cookieName);
    if (kept) out.push(`${def.cookieName}=${kept}`);
  }
  return out.filter((s) => s !== '').join('; ');
}

/** 已保存的 Cookie 头 → 各字段裸值（供表单遮蔽展示与「已配置」判定） */
export function splitCookieFields(
  storedHeader: string,
  defs: readonly CookieFieldDef[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const def of defs) {
    const v = cookieFieldValue(storedHeader, def.cookieName);
    if (v) out[def.key] = v;
  }
  return out;
}
