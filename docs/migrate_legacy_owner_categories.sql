-- Run this whole script in Supabase SQL Editor.
-- It moves only unowned rows and the three known old owner IDs.

BEGIN;

UPDATE public.categories
SET user_id = (SELECT id FROM auth.users WHERE email = 'kr.wn20@gmail.com' LIMIT 1)
WHERE user_id IS NULL OR user_id IN (
  '5aa42527-12fc-448a-a108-70531f3c5607'::uuid,
  '2463bf7f-f454-454f-b8bc-b8328f85069b'::uuid,
  '7d88ef85-b3e7-4eb5-a00d-1c61a6bb0d28'::uuid
);

UPDATE public.transactions
SET user_id = (SELECT id FROM auth.users WHERE email = 'kr.wn20@gmail.com' LIMIT 1)
WHERE user_id IS NULL OR user_id IN (
  '5aa42527-12fc-448a-a108-70531f3c5607'::uuid,
  '2463bf7f-f454-454f-b8bc-b8328f85069b'::uuid,
  '7d88ef85-b3e7-4eb5-a00d-1c61a6bb0d28'::uuid
);

UPDATE public.push_subscriptions
SET user_id = (SELECT id FROM auth.users WHERE email = 'kr.wn20@gmail.com' LIMIT 1)
WHERE user_id IS NULL OR user_id IN (
  '5aa42527-12fc-448a-a108-70531f3c5607'::uuid,
  '2463bf7f-f454-454f-b8bc-b8328f85069b'::uuid,
  '7d88ef85-b3e7-4eb5-a00d-1c61a6bb0d28'::uuid
);

COMMIT;

SELECT
  (SELECT count(*) FROM public.categories WHERE user_id IS NULL) AS unowned_categories,
  (SELECT count(*) FROM public.transactions WHERE user_id IS NULL) AS unowned_transactions,
  (SELECT count(*) FROM public.categories WHERE user_id = (SELECT id FROM auth.users WHERE email = 'kr.wn20@gmail.com' LIMIT 1)) AS owner_categories,
  (SELECT count(*) FROM public.transactions WHERE user_id = (SELECT id FROM auth.users WHERE email = 'kr.wn20@gmail.com' LIMIT 1)) AS owner_transactions;
