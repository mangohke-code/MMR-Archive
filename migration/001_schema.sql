-- 니케 정보 모음 — Supabase 스키마
-- Supabase 대시보드 > SQL Editor 에 전체를 붙여넣고 실행하면 됨.

-- ========== 메인 페이지 ==========

create table site_config (
  id bigint generated always as identity primary key,
  key text not null unique,
  value text
);

create table events (
  id bigint generated always as identity primary key,
  name text not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  image_url text,
  kind text -- '신규' | '복각'
);

create table pickup_thumbnails (
  id bigint generated always as identity primary key,
  nikke_name text not null,
  image_url text
);

-- ========== 픽업 기록 ==========

-- 복각 여부는 지금처럼("이름 중복 + F~J열 비어있음") 프론트에서 매번 계산 — 컬럼으로 안 둠
create table pickups (
  id bigint generated always as identity primary key,
  season text,
  event text,
  start_at timestamptz not null,
  end_at timestamptz not null,
  nikke_name text not null,
  company text,
  type text,
  burst text,
  code text,
  weapon text,
  banner text
);

create index pickups_nikke_name_idx on pickups (nikke_name);
create index pickups_start_at_idx on pickups (start_at);

-- ========== 유니크 코스튬 ==========

create table costumes (
  id bigint generated always as identity primary key,
  nikke_name text not null,
  costume_name text not null,
  start_at timestamptz,
  end_at timestamptz,
  rerun_start_at timestamptz,
  rerun_end_at timestamptz,
  ticket_name text,
  free_ticket_url text,
  paid_ticket_url text,
  skel_url text,
  atlas_url text
);

-- ========== 기념품 ==========

create table souvenirs (
  id bigint generated always as identity primary key,
  name text not null,
  event text,
  season text,
  image_url text,
  method text,
  description text
);

-- ========== 스테이지 정보 ==========

create table stages (
  id bigint generated always as identity primary key,
  chapter text not null,
  stage text not null,
  normal_power text,
  normal_boss text,
  normal_code text,
  normal_type text,
  hard_power text,
  hard_boss text,
  hard_code text,
  hard_type text,
  story text,
  notes text
);

-- ========== 미실장 캐릭터 ==========
-- 원본 시트(A~N열, 등장1/이름1/... x 2세트)를 그대로 복사-붙여넣기 할 수 있도록 컬럼 순서를 시트와 동일하게 유지.
-- 나중에 등장3 이상이 필요해지면 name3..atlas3 컬럼을 추가로 만들면 됨.

create table unreleased_characters (
  id bigint generated always as identity primary key,
  name1 text,
  affiliation1 text,
  squad1 text,
  status1 text,     -- '이름빗금' | '스쿼드빗금' | '전체빗금' | null
  appearance1 text, -- 등장 시점 (예: '2챕터', '2주년', 'FOOTSTEP, WALK, RUN')
  skel1 text,
  atlas1 text,
  name2 text,
  affiliation2 text,
  squad2 text,
  status2 text,
  appearance2 text,
  skel2 text,
  atlas2 text
);

-- ========== 이미지 테이블 ==========

create table nikke_images (
  id bigint generated always as identity primary key,
  nikke_name text not null unique,
  portrait_url text,
  costume1_name text,
  costume1_image_url text,
  costume2_name text,
  costume2_image_url text
);

create table icons (
  id bigint generated always as identity primary key,
  category text not null, -- 기업 | 유형 | 우월코드 | 버스트 | 총기
  key text not null,      -- 예: '작열', '화력형', 'AR'
  image_url text,
  unique (category, key)
);

create table chapter_images (
  id bigint generated always as identity primary key,
  chapter text not null unique,
  image_url text,
  name text
);

-- ========== RLS: 전부 익명 읽기만 허용, 쓰기는 대시보드(서비스 롤)로만 ==========

do $$
declare
  t text;
begin
  for t in
    select unnest(array[
      'site_config', 'events', 'pickup_thumbnails', 'pickups', 'costumes',
      'souvenirs', 'stages', 'unreleased_characters',
      'nikke_images', 'icons', 'chapter_images'
    ])
  loop
    execute format('alter table %I enable row level security;', t);
    execute format(
      'create policy "public read" on %I for select to anon, authenticated using (true);',
      t
    );
    -- RLS 정책만으론 부족하고, 테이블 자체에 대한 기본 조회 권한도 따로 필요함
    -- ("Automatically expose new tables"를 꺼둔 경우 이게 자동으로 안 걸림)
    execute format('grant select on %I to anon, authenticated;', t);
  end loop;
end $$;
