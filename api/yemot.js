// שלוחת API של ימות המשיח — משתתפים עונים לטריוויה מהטלפון (גם טלפון כשר).
// ימות שולחת לכאן בכל פנייה את כל מה שנאסף בשיחה; אנחנו עונים בטקסט מה להשמיע ומה לקלוט.
// פרמטרים שאנחנו מבקשים: G1,G2.. = קוד משחק; A{n}_{t}_{q} = הקשה מספר n,
// t = עד איזו שאלה כבר הודענו תוצאה (i+1), q = עד איזו שאלה כבר הודענו "שאלה פתוחה" (i+1).

const crypto = require('crypto');
const DB_URL = 'https://trivia-clickers-default-rtdb.europe-west1.firebasedatabase.app';
const WAIT = 8;          // שניות המתנה להקשה לפני שבודקים שוב מה המצב במשחק
const GRACE = 1500;      // מרווח קטן אחרי שהזמן נגמר (עיכוב בקו)

async function db(path, method = 'GET', body) {
  const r = await fetch(`${DB_URL}/${path}.json`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!r.ok) throw new Error('db ' + r.status);
  return r.json();
}

// טקסט להקראה — בלי תווים שאסורים אצל ימות
const say = s => 't-' + String(s).replace(/[.\-&=,"]/g, ' ').replace(/\s+/g, ' ').trim();
const msgs = arr => arr.filter(Boolean).map(say).join('.');

// בקשת הקשה: הודעה ואז ספרה אחת (או 4 לקוד), בלי אישור, ריק = none
function read(prompt, name, { min = 1, max = 1, wait = WAIT, keys = '' } = {}) {
  const head = prompt || 'noop-wait';
  return `read=${head}=${name},no,${max},${min},${wait},NO,yes,no,,${keys},1,Ok,none,,no`;
}
const bye = arr => `id_list_message=${msgs(arr)}&go_to_folder=hangup`;

function params(req) {
  const p = Object.assign({}, req.query || {});
  let b = req.body;
  if (typeof b === 'string') b = Object.fromEntries(new URLSearchParams(b));
  if (b && typeof b === 'object') Object.assign(p, b);
  return p;
}

async function handle(p) {
  if (p.hangup === 'yes') return 'noop=hangup';
  const phone = String(p.ApiPhone || '').replace(/\D/g, '');
  const pid = 'tel_' + (phone || String(p.ApiCallId || Date.now()).replace(/[^\w]/g, ''));
  const name = '📞 ' + (phone ? phone.slice(-4) : 'חסוי');

  const gKeys = Object.keys(p).filter(k => /^G\d+$/.test(k)).sort((a, b) => a.slice(1) - b.slice(1));
  const aKeys = Object.keys(p).filter(k => /^A\d+_\d+_\d+$/.test(k)).sort((a, b) => a.split('_')[0].slice(1) - b.split('_')[0].slice(1));

  // שלב 1 — קוד משחק
  if (!gKeys.length) return read(msgs(['ברוכים הבאים לטריוויה', 'הקישו את קוד המשחק בן ארבע הספרות שמופיע על המסך']), 'G1', { min: 4, max: 4, wait: 15 });
  const lastG = gKeys[gKeys.length - 1];
  const code = String(p[lastG] || '').replace(/\D/g, '');
  const tryAgain = why => gKeys.length >= 4
    ? bye([why, 'נסו להתקשר שוב'])
    : read(msgs([why, 'הקישו שוב את קוד המשחק']), 'G' + (gKeys.length + 1), { min: 4, max: 4, wait: 15 });

  const meta = code.length === 4 ? await db(`games/${code}/meta`) : null;
  if (!meta || (!aKeys.length && Date.now() - (meta.created || 0) > 6 * 3600e3)) return tryAgain('לא נמצא משחק עם הקוד הזה');
  const cfg = meta.cfg || {};

  // שלב 2 — הצטרפות (רק בפעם הראשונה)
  if (!aKeys.length) {
    if (meta.state === 'end') return tryAgain('המשחק הזה כבר הסתיים');
    if (cfg.joinMode === 'clickers') return bye(['במשחק הזה משחקים עם השלטים בלבד']);
    if (cfg.joinMode === 'app' || cfg.joinMode === 'phones') return bye(['במשחק הזה משחקים רק דרך האפליקציה בסמארטפון', 'סרקו את הקוד שעל המסך']);
    const existing = await db(`games/${code}/players/${pid}`);
    if (!existing) {
      if (cfg.lateJoin === false && meta.state !== 'lobby') return bye(['המשחק כבר התחיל ואי אפשר להצטרף באמצע']);
      if (cfg.maxPlayers > 0 && Object.keys((await db(`games/${code}/players`, 'GET')) || {}).length >= cfg.maxPlayers) return bye(['המשחק מלא']);
    }
    // טלפונים מוכרים — השם מהרשימה שהוזנה מראש (המפתח הוא גיבוב של המספר, כמו בדף המנחה)
    let known = null;
    const local = phone.startsWith('972') ? '0' + phone.slice(3) : phone;
    if (local) known = await db(`games/${code}/phonebook/${crypto.createHash('sha256').update('trivia:' + local).digest('hex').slice(0, 20)}`);
    if (!existing || known) await db(`games/${code}/players/${pid}`, 'PATCH', existing ? { name: '📞 ' + known } : { name: known ? '📞 ' + known : name, score: 0, joined: { '.sv': 'timestamp' } });
    const intro = [known ? `שלום ${known}` : '', 'נכנסתם למשחק', known ? '' : phone ? `על המסך תופיעו בשם טלפון ${phone.slice(-4).split('').join(' ')}` : '',
      'כשמופיעה שאלה על המסך הקישו את מספר התשובה', 'אחת שתיים שלוש או ארבע', 'אפשר להישאר על הקו עד סוף המשחק'];
    return read(msgs(intro), 'A1_0_0');
  }

  // שלב 3 — במהלך המשחק
  const lastA = aKeys[aKeys.length - 1];
  const [nS, tS, qS] = lastA.slice(1).split('_');
  let n = +nS, told = +tS, asked = +qS;
  const v = String(p[lastA] || 'none');
  const out = [];

  if (meta.state === 'end') {
    const r = await db(`games/${code}/results/${pid}`);
    // meta.ad.say — משפט הפרסום של המנחה (רק אם הופעל "בטלפון של המשתתפים בסוף")
    return bye(['המשחק נגמר', r && r.rank ? `סיימתם במקום ${r.rank} מתוך ${r.of} עם ${r.score} נקודות` : '', 'תודה ששיחקתם', meta.ad && meta.ad.say]);
  }
  if (!(await db(`games/${code}/players/${pid}`))) return bye(['הוצאתם מהמשחק']);

  const q = meta.q || {};
  const nAns = (q.answers || []).length || 4;
  const open = meta.state === 'question' && Date.now() <= (q.start || 0) + (q.dur || 0) * 1000 + GRACE;

  if (/^\d$/.test(v)) {
    if (!open) out.push(meta.state === 'lobby' ? 'המשחק עוד לא התחיל' : 'אין כרגע שאלה פתוחה');
    else if (await db(`games/${code}/answers/${meta.i}/${pid}`)) out.push('כבר עניתם על השאלה הזאת');
    else if (+v < 1 || +v > nAns) out.push(`הקישו מספר מאחת עד ${nAns}`);
    else {
      await db(`games/${code}/answers/${meta.i}/${pid}`, 'PUT', { a: +v - 1, t: { '.sv': 'timestamp' } });
      out.push(q.poll ? 'ההצבעה נקלטה' : 'התשובה נקלטה');
    }
    asked = Math.max(asked, (meta.i ?? -1) + 1);
  }

  // תוצאה של השאלה האחרונה (פעם אחת לכל שאלה)
  if ((meta.state === 'reveal' || meta.state === 'board') && meta.reveal && meta.reveal.i + 1 > told) {
    told = meta.reveal.i + 1;
    const r = await db(`games/${code}/results/${pid}`);
    if (r && r.i === meta.reveal.i && !r.poll) {
      if (cfg.feedback === false) out.push(r.answered ? 'התשובה נקלטה' : 'הזמן נגמר');
      else {
        out.push(r.ok ? `תשובה נכונה ${r.pts} נקודות` : r.answered ? 'לא נכון' : 'הזמן נגמר');
        if (r.rank) out.push(`אתם במקום ${r.rank} מתוך ${r.of}`);
      }
    }
  }

  // הודעה על שאלה חדשה שנפתחה (פעם אחת לכל שאלה)
  if (open && meta.i + 1 > asked) {
    asked = meta.i + 1;
    out.push(`שאלה ${meta.i + 1}`, q.poll ? 'סקר' : '', `הקישו מאחת עד ${nAns}`);
  }

  return read(out.length ? msgs(out) : '', `A${n + 1}_${told}_${asked}`);
}

module.exports = async (req, res) => {
  let text;
  const p = params(req);
  try { text = await handle(p); }
  catch (e) { console.error(e); text = read(msgs(['תקלה זמנית', 'הקישו שוב']), 'E' + Date.now()); }
  console.log('YEMOT', JSON.stringify(p), '=>', text); // זמני — אבחון ניתוקים
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.status(200).send(text);
};
