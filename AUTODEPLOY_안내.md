# CDMS 자동배포(CI/CD)

개발 후 `git push` 한 번 → GitHub·Vercel·Supabase 자동 반영.

| 대상 | 방법 | 자동 |
|---|---|---|
| Vercel(프런트 cdms-deploy) | GitHub 연동 | ✅ 기존 |
| Supabase Edge Functions | `.github/workflows/deploy-supabase.yml` | ✅ (이 PR 후) |
| DB 마이그레이션 | 같은 워크플로의 수동 버튼(Actions>Run workflow>run_migrations) | 수동 |

## 시크릿 (등록 완료)
SUPABASE_ACCESS_TOKEN, SUPABASE_DB_PASSWORD — 저장소 Settings>Secrets>Actions.

## 동작
- `supabase/functions/**` 또는 `config.toml` push → 함수 5종 자동 deploy.
- 함수별 verify_jwt 은 `supabase/config.toml` 기준.
- 마이그레이션은 수동(히스토리 정합 후): Actions 탭 > Run workflow > run_migrations 체크.

## 평소
```
./dev-push.sh "기능 설명"
```
