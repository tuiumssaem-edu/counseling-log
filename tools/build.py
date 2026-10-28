"""index.html 만들기: src/index.template.html 안에 apps-script/Code.gs를 넣습니다.

사용법: python3 tools/build.py
앱의 '앱스크립트 코드 복사' 버튼이 이 코드를 복사합니다.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
template = (ROOT / "src" / "index.template.html").read_text(encoding="utf-8")
code = (ROOT / "apps-script" / "Code.gs").read_text(encoding="utf-8")

if "</script" in code.lower():
    raise SystemExit("Code.gs 안에 </script 가 있으면 안 됩니다.")
marker = "/*__GS_CODE__*/"
if template.count(marker) != 1:
    raise SystemExit("템플릿에 코드 자리표시가 정확히 한 번 있어야 합니다.")

(ROOT / "index.html").write_text(template.replace(marker, code), encoding="utf-8")
print("index.html 생성 완료")
