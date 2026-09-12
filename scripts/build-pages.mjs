import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs');
fs.mkdirSync(out, { recursive: true });
let html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
html = html.replace('<head>', `<head>
  <meta name="lab-runtime" content="browser">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://api.upbit.com wss://api.upbit.com; base-uri 'self'; form-action 'self'">`)
  .replaceAll('href="/"', 'href="./"').replaceAll('href="/favicon.svg"', 'href="./favicon.svg"')
  .replaceAll('href="/style.css"', 'href="./style.css"').replaceAll('src="/app.js"', 'src="./app.js"')
  .replaceAll('href="/api/export?mode=paper"', 'href="#export"')
  .replace('EXPERIMENT / 001', 'GITHUB PAGES')
  .replace('브라우저를 닫아도 로컬 서버가 켜져 있으면 계속 실행됩니다. 컴퓨터 절전·종료 중에는 작동하지 않습니다.', '이 페이지가 열려 있는 동안 실행됩니다. 탭 종료·절전·모바일 백그라운드에서는 멈출 수 있습니다.')
  .replace('실제 수집한 시점만 표시 · 서버 종료 중에는 기록되지 않습니다.', '실제 수집한 시점만 표시 · 페이지 종료 중에는 기록되지 않습니다.')
  .replace('로컬 저장 · API 키 불필요 · 실제 주문 기능 없음', '이 브라우저에만 기록 저장 · API 키 불필요 · 실제 주문 없음');
fs.writeFileSync(path.join(out, 'index.html'), html);
for (const file of ['app.js', 'style.css', 'favicon.svg']) fs.copyFileSync(path.join(root, 'public', file), path.join(out, file));
for (const file of ['engine.mjs', 'browser-runtime.mjs', 'pages-state.mjs', 'market-universe.mjs']) fs.copyFileSync(path.join(root, file), path.join(out, file));
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log('GitHub Pages 정적 파일 생성 완료: docs/ (계정·거래 데이터 포함 없음)');
