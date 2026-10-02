ALTER TABLE "pricing"."price_fee_action_result_receipts" DROP CONSTRAINT "pricing_price_fee_action_results_outcome_ck", ADD CONSTRAINT "pricing_price_fee_action_results_outcome_ck" CHECK (case
      when "action_kind" = 'DEFINE_PRICE' then "result_payload"->>'outcome' in ('CREATED', 'REUSED', 'CONFLICT')
      when "action_kind" = 'REVISE_PRICE' then "result_payload"->>'outcome' in ('REVISED', 'UNCHANGED', 'CONFLICT')
      when "action_kind" = 'DEFINE_COMMERCIAL_FEE' then "result_payload"->>'outcome' in ('COMMERCIAL_FEE_CREATED', 'COMMERCIAL_FEE_REUSED')
      else "result_payload"->>'outcome' in ('COMMERCIAL_FEE_REVISED', 'COMMERCIAL_FEE_UNCHANGED')
    end);