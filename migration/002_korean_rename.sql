-- 테이블/컬럼 이름을 전부 한글로 변경 (데이터는 그대로 유지됨)

alter table "site_config" rename column "key" to "키";
alter table "site_config" rename column "value" to "값";
alter table "site_config" rename column "id" to "번호";
alter table "site_config" rename to "사이트_설정";

alter table "events" rename column "name" to "이벤트명";
alter table "events" rename column "start_at" to "시작일";
alter table "events" rename column "end_at" to "종료일";
alter table "events" rename column "image_url" to "이미지";
alter table "events" rename column "kind" to "신규복각";
alter table "events" rename column "id" to "번호";
alter table "events" rename to "이벤트";

alter table "pickup_thumbnails" rename column "nikke_name" to "니케";
alter table "pickup_thumbnails" rename column "image_url" to "이미지";
alter table "pickup_thumbnails" rename column "id" to "번호";
alter table "pickup_thumbnails" rename to "픽업_썸네일";

alter table "pickups" rename column "season" to "시즌";
alter table "pickups" rename column "event" to "이벤트";
alter table "pickups" rename column "start_at" to "시작일";
alter table "pickups" rename column "end_at" to "종료일";
alter table "pickups" rename column "nikke_name" to "니케";
alter table "pickups" rename column "company" to "기업";
alter table "pickups" rename column "type" to "유형";
alter table "pickups" rename column "burst" to "버스트";
alter table "pickups" rename column "code" to "우월코드";
alter table "pickups" rename column "weapon" to "총기";
alter table "pickups" rename column "banner" to "픽업_배너";
alter table "pickups" rename column "id" to "번호";
alter table "pickups" rename to "픽업_기록";

alter table "costumes" rename column "nikke_name" to "니케";
alter table "costumes" rename column "costume_name" to "코스튬명";
alter table "costumes" rename column "start_at" to "시작일";
alter table "costumes" rename column "end_at" to "종료일";
alter table "costumes" rename column "rerun_start_at" to "복각_시작일";
alter table "costumes" rename column "rerun_end_at" to "복각_종료일";
alter table "costumes" rename column "ticket_name" to "티켓";
alter table "costumes" rename column "free_ticket_url" to "무료티켓";
alter table "costumes" rename column "paid_ticket_url" to "유료티켓";
alter table "costumes" rename column "skel_url" to "skel";
alter table "costumes" rename column "atlas_url" to "atlas";
alter table "costumes" rename column "ticket_description" to "티켓_설명";
alter table "costumes" rename column "id" to "번호";
alter table "costumes" rename to "유니크_코스튬";

alter table "souvenirs" rename column "name" to "이름";
alter table "souvenirs" rename column "event" to "이벤트";
alter table "souvenirs" rename column "season" to "시즌";
alter table "souvenirs" rename column "image_url" to "이미지";
alter table "souvenirs" rename column "method" to "획득_방법";
alter table "souvenirs" rename column "description" to "설명";
alter table "souvenirs" rename column "id" to "번호";
alter table "souvenirs" rename to "기념품";

alter table "stages" rename column "chapter" to "챕터";
alter table "stages" rename column "stage" to "스테이지";
alter table "stages" rename column "normal_power" to "노말전투력";
alter table "stages" rename column "normal_boss" to "노말보스";
alter table "stages" rename column "normal_code" to "노말약점";
alter table "stages" rename column "normal_type" to "노말유형";
alter table "stages" rename column "hard_power" to "하드전투력";
alter table "stages" rename column "hard_boss" to "하드보스";
alter table "stages" rename column "hard_code" to "하드약점";
alter table "stages" rename column "hard_type" to "하드유형";
alter table "stages" rename column "story" to "스토리";
alter table "stages" rename column "notes" to "특이사항";
alter table "stages" rename column "id" to "번호";
alter table "stages" rename to "스테이지_정보";

alter table "unreleased_characters" rename column "name1" to "이름1";
alter table "unreleased_characters" rename column "affiliation1" to "소속1";
alter table "unreleased_characters" rename column "squad1" to "스쿼드1";
alter table "unreleased_characters" rename column "status1" to "상태1";
alter table "unreleased_characters" rename column "appearance1" to "등장1";
alter table "unreleased_characters" rename column "name2" to "이름2";
alter table "unreleased_characters" rename column "affiliation2" to "소속2";
alter table "unreleased_characters" rename column "squad2" to "스쿼드2";
alter table "unreleased_characters" rename column "status2" to "상태2";
alter table "unreleased_characters" rename column "appearance2" to "등장2";
alter table "unreleased_characters" rename column "id" to "번호";
alter table "unreleased_characters" rename to "미실장_캐릭터";

alter table "nikke_images" rename column "nikke_name" to "이름";
alter table "nikke_images" rename column "portrait_url" to "이미지";
alter table "nikke_images" rename column "costume1_name" to "코스튬1";
alter table "nikke_images" rename column "costume1_image_url" to "코스튬1_이미지";
alter table "nikke_images" rename column "costume2_name" to "코스튬2";
alter table "nikke_images" rename column "costume2_image_url" to "코스튬2_이미지";
alter table "nikke_images" rename column "id" to "번호";
alter table "nikke_images" rename to "IMG_니케";

alter table "icons" rename column "category" to "카테고리";
alter table "icons" rename column "key" to "키";
alter table "icons" rename column "image_url" to "이미지";
alter table "icons" rename column "id" to "번호";
alter table "icons" rename to "IMG_아이콘";

alter table "chapter_images" rename column "chapter" to "챕터";
alter table "chapter_images" rename column "image_url" to "이미지";
alter table "chapter_images" rename column "name" to "명칭";
alter table "chapter_images" rename column "id" to "번호";
alter table "chapter_images" rename to "IMG_챕터";
