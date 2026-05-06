# 동아리방 시간표

밴드 동아리 동아리방 시간표 관리 웹앱.  
**GitHub Pages** (프론트) + **Supabase** (DB + API) 구성.

---

## 아키텍처

```
GitHub Pages (index.html, js/)
        │
        │  HTTPS (supabase-js SDK)
        ▼
  Supabase (PostgreSQL + REST API + Realtime)
```

별도 백엔드 서버 없음. Supabase가 REST API와 실시간 구독을 모두 제공.

---

## 1단계 — Supabase 프로젝트 생성

1. [https://supabase.com](https://supabase.com) 접속 → **Start your project**
2. 새 Organization & Project 생성 (무료 플랜으로 충분)
3. **Project Settings > API** 에서 다음 두 값 복사:
   - `Project URL` → `https://xxxx.supabase.co`
   - `anon public` 키

---

## 2단계 — DB 스키마 적용

Supabase Dashboard **> SQL Editor > New query** 에서 `schema.sql` 전체 내용을 붙여넣고 실행.

> 초기 팀 데이터와 샘플 슬롯이 자동으로 삽입됩니다.

---

## 3단계 — Supabase 키 입력

`js/supabase.js` 파일을 열고 두 줄 수정:

```js
const SUPABASE_URL      = 'https://YOUR_PROJECT_ID.supabase.co';  // ← 교체
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';                         // ← 교체
```

> **주의**: `anon` 키는 클라이언트에 노출되어도 괜찮습니다 (Supabase 설계상 공개 키).  
> 단, RLS(Row Level Security) 정책이 schema.sql에 적용되어 있으므로 데이터 보호는 DB 레이어에서 처리됩니다.

---

## 4단계 — 관리자 비밀번호 변경

Supabase **SQL Editor** 에서 실행:

```sql
update app_config set value = '원하는비밀번호' where key = 'admin_password';
```

기본값 `band1234` 는 반드시 변경하세요.

---

## 5단계 — GitHub Pages 배포

```bash
# 리포지토리 루트에 파일들이 있는지 확인
ls
# index.html  js/  schema.sql  README.md

git add .
git commit -m "feat: initial deploy"
git push origin main
```

이후 GitHub **Settings > Pages > Branch: main / root** 로 설정하면 배포 완료.

---

## 파일 구조

```
/
├── index.html          # 앱 진입점 (전체 UI)
├── js/
│   ├── supabase.js     # Supabase 클라이언트 (URL·키 입력 필요)
│   ├── auth.js         # 관리자 인증 (세션 기반)
│   └── schedule.js     # 슬롯·팀·신청 CRUD + 실시간 구독
├── schema.sql          # DB 스키마 + 초기 데이터
└── README.md
```

---

## 기능 요약

| 기능 | 이용자 | 관리자 |
|------|--------|--------|
| 시간표 조회 (주차 이동) | ✅ | ✅ |
| 미사용 신고 | ✅ | ✅ |
| 추가 사용 신청 | ✅ | ✅ |
| 빈 시간대 빠른 신청 | ✅ | ✅ |
| 신청 승인 / 거절 | ❌ | ✅ |
| 슬롯 추가 / 수정 / 삭제 | ❌ | ✅ |
| 팀 추가 / 삭제 | ❌ | ✅ |
| 실시간 시간표 반영 | ✅ | ✅ |

---

## Supabase 무료 플랜 제한

- DB 500MB, 월 2GB 트래픽 — 300명 규모 동아리에서 여유 있게 사용 가능
- 비활성 프로젝트는 7일 후 일시정지 (주 1회 접속으로 유지 가능)
