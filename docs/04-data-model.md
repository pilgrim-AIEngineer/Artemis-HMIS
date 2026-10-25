# 04 — Data model

Relational core in PostgreSQL. Every table below implicitly has: `id uuid pk (UUIDv7)`, `facility_id uuid not null`, `created_at`, `updated_at`, `created_by`, `updated_by` unless stated. `status` columns use text with CHECK constraints (enums live in `packages/shared/enums.ts`). Money columns end in `_paise` (bigint). Phase markers: [P1], [P2A], [P2B], [P3].

## 1. Platform [P1]

| Table | Key columns |
| --- | --- |
| `facility` | name, short_name, address, district, state, pincode, phone, email, gstin, clinical_establishment_reg_no, pcpndt_reg_no, mtp_approval_no, drug_licence_nos jsonb, hfr_id (P3), logo_file_id |
| `app_user` | username unique, full_name, mobile, password_hash, pin_hash, preferred_locale, is_active, last_login_at, totp_secret_enc |
| `role` / `permission` / `role_permission` / `user_role` | standard RBAC |
| `session` | user_id, token_hash, workstation_id, created_at, last_seen_at, expires_at, revoked_at |
| `workstation` | name, location, default_printer_thermal, default_printer_a4, default_printer_a5, qz_enabled |
| `setting` | key, value jsonb (unique facility_id+key) |
| `number_series` | key, fy, prefix, next_value, padding (unique facility_id+key+fy) |
| `audit_log` | table_name, row_id, action, changed_by, workstation_id, changed_at, before jsonb, after jsonb (no updated_* columns) |
| `access_log` | user_id, entity, entity_id, purpose, at |
| `idempotency` | key unique, procedure, result jsonb |
| `document` | kind (rx_scan, form_f_signed, consent, report_pdf, photo, ecg, other), entity, entity_id, file_path, mime, size_bytes, sha256, pages |
| `print_log` | template, entity, entity_id, copy_no, user_id, workstation_id |

## 2. Organisation and masters [P1]

| Table | Key columns |
| --- | --- |
| `department` | name, code (GYN, PAED, CARD, PATH, RAD, PHARM, ANES), is_clinical, is_active |
| `doctor_profile` | user_id (nullable for visiting doctors), department_id, display_name, qualifications, registration_council, registration_no, signature_file_id, is_visiting, opd_days jsonb, consultation rules jsonb |
| `payer` | name, type (`self`, `pmjay`, `state_scheme`, `tpa`, `insurer`, `corporate`, `cghs`, `echs`, `other`), code, contact, credit_days, requires_preauth bool, is_active. Seed: one row `Cash / Self` (type `self`). |
| `tariff` | name, payer_id nullable (default tariff when null), effective_from, effective_to, is_active. Seed: `Standard (Cash)`. |
| `service` | code, name, name_hi, category (`consultation`, `procedure`, `usg`, `lab`, `bed`, `nursing`, `ot`, `doctor_visit`, `equipment`, `misc`, `cardiology`, `icu`), department_id, sac_code, default_gst_rate_bp, is_exempt bool, unit (`per_visit`, `per_day`, `per_hour`, `per_unit`), linked_lab_test_id, linked_usg_procedure_id, is_active |
| `service_rate` | service_id, tariff_id, room_category_id nullable (rate varies by room for IPD), rate_paise, unique(service, tariff, room_category) |
| `consultation_rule` | doctor_id, visit_type (`new`, `follow_up`, `emergency`, `anc`, `paeds_vaccination`), service_id, follow_up_validity_days, free_follow_ups_count |
| `drug` | brand_name, generic_name, strength, form (`tab`, `cap`, `syp`, `inj`, `drops`, `cream`, `pessary`, `sachet`, `inhaler`, `other`), manufacturer, hsn_code, gst_rate_bp, schedule (`none`, `H`, `H1`, `X`, `G`, `NDPS`), is_stocked bool, default_dose_text, pack_size, is_active. Used by Rx even before pharmacy goes live. |
| `locality` | name, name_hi, district, pincode, learned bool |
| `reason_code` | kind (`discount`, `cancel`, `refund`, `stock_adjust`, `no_show`), label, label_hi |

## 3. Patient [P1]

| Table | Key columns |
| --- | --- |
| `patient` | uhid unique, first_name, middle_name, last_name, full_name (generated), name_hi, sex (`F`,`M`,`O`), dob, dob_is_estimated, mobile, alt_mobile, relation_to_mobile_owner (`self`, `wife`, `daughter`, `son`, `mother`, ...), guardian_name, guardian_relation (`husband`, `father`, `mother`, `other`), address_line, locality_id, district, state, pincode, blood_group, marital_status, occupation, referred_by, photo_file_id, is_deceased, deceased_at, merged_into_id, search_name_norm, search_name_phonetic, status |
| `patient_identifier` | patient_id, type (`abha_number`, `abha_address`, `aadhaar_masked`, `pmjay_id`, `insurance_member_id`, `employee_id`, `other`), value, verified_at. Never store full Aadhaar. |
| `patient_allergy` | patient_id, allergen, reaction, severity, noted_by |
| `patient_alert` | patient_id, kind (`high_risk_pregnancy`, `allergy`, `vip`, `mlc`, `other`), text, active |
| `patient_payer_coverage` [P2B] | patient_id, payer_id, member_id, policy_no, card_holder_name, relation, valid_from, valid_to, documents |

## 4. Encounters and queue [P1]

| Table | Key columns |
| --- | --- |
| `encounter` | patient_id, type (`opd`, `ipd`, `daycare`, `emergency`), number (OP/IP series), doctor_id, department_id, payer_id (default Cash), tariff_id, visit_type, chief_complaint_short, started_at, ended_at, status (`open`, `closed`, `cancelled`), is_restricted bool, referral_source, is_downtime_entry, pregnancy_id nullable |
| `opd_token` | encounter_id, doctor_id, token_date, token_no, priority (`normal`, `emergency`, `labour`, `elderly`, `staff`, `vip`), queue_state (`waiting`, `vitals_done`, `with_doctor`, `seen`, `rx_entered`, `billed_orders`, `done`, `no_show`, `cancelled`), called_at, seen_at, done_at, unique(doctor_id, token_date, token_no) |
| `appointment` | patient_id nullable, name, mobile, doctor_id, slot_start, slot_end, source (`phone`, `walk_in`, `whatsapp`), status (`booked`, `arrived`, `cancelled`, `no_show`), encounter_id |
| `queue_event` | token_id, from_state, to_state, by_user, at (for wait-time analytics) |

## 5. Clinical [P1 unless marked]

| Table | Key columns |
| --- | --- |
| `vitals` | encounter_id, patient_id, recorded_at, bp_sys, bp_dia, pulse, temp_c, spo2, rr, weight_kg, height_cm, bmi (computed), head_circ_cm, muac_cm, rbs_mgdl, hb_gdl, pain_score, recorded_by, flags jsonb |
| `clinical_note` | encounter_id, kind (`opd`, `ipd_progress`, `ipd_admission`, `procedure`), complaints jsonb [{text, duration}], history text, examination jsonb, provisional_diagnosis jsonb [{text, icd10?}], advice text, follow_up_date, status (`draft`, `final`), entered_by, verified_by, verified_at |
| `prescription` | encounter_id, patient_id, doctor_id, source (`transcribed_from_paper`, `entered_by_doctor`, `discharge`), status (`draft`, `final`, `verified`, `cancelled`), entered_by, entered_at, verified_by, verified_at, paper_scan_document_id, notes, rx_template_id |
| `prescription_item` | prescription_id, seq, drug_id nullable, free_text_drug, dose_text, frequency_code (`OD`,`BD`,`TDS`,`QID`,`HS`,`SOS`,`STAT`,`WEEKLY`, `1-0-1` style stored as `pattern`), pattern (e.g. `1-0-1`), timing (`af`, `bf`, `with_food`, `empty_stomach`, `any`), route, duration_value, duration_unit (`d`,`w`,`m`), quantity_calc numeric, instructions_en, instructions_hi |
| `rx_template` / `rx_template_item` | owner doctor_id (or global), name, specialty, items, default advice, default tests |
| `clinical_order` | encounter_id, patient_id, kind (`lab`, `usg`, `procedure`, `admission`, `referral`, `cardiology_test`), service_id, lab_test_id / lab_panel_id / usg_procedure_id, priority, notes, status (`ordered`, `billed`, `in_progress`, `completed`, `cancelled`), ordered_by, entered_by, bill_line_id |
| `pregnancy` | patient_id, lmp, edd_by_lmp, edd_by_scan, edd_final, gravida, para, abortions, living, status (`active`, `delivered`, `aborted`, `mtp`, `ectopic`, `lost_to_follow_up`, `transferred`), outcome_date, outcome_encounter_id, risk_flags text[], blood_group_rh, notes |
| `obstetric_history` | patient_id, pregnancy_no, year, outcome (`nvd`, `lscs`, `assisted`, `abortion`, `ectopic`, `stillbirth`, `mtp`), gestation_weeks, place, complications, baby_alive |
| `anc_visit` | pregnancy_id, encounter_id, visit_date, ga_days (computed at visit), weight_kg, bp_sys, bp_dia, fundal_height_cm, fhr, presentation, oedema, urine_protein, urine_sugar, hb, remarks |
| `anc_schedule_item` (master) | code, label, label_hi, kind (`visit`, `test`, `scan`, `vaccine`, `supplement`), ga_from_days, ga_to_days, is_active |
| `anc_schedule_status` | pregnancy_id, schedule_item_id, status (`due`, `done`, `skipped`), done_date, encounter_id |
| `immunisation_schedule` (master) | schedule_name (`IAP`, `UIP`), vaccine_code, label, dose_no, due_age_days, min_age_days, max_age_days, is_optional |
| `immunisation_given` | patient_id, schedule_item_id nullable, vaccine_name, brand, batch_no, expiry, site, route, given_at, given_by, encounter_id, next_due_date |
| `growth_measurement` | patient_id, measured_on, weight_kg, length_height_cm, head_circ_cm, z_scores jsonb (computed), encounter_id |
| `addendum` | entity, entity_id, text, added_by, added_at |

## 6. Billing [P1, IPD parts P2A, payer parts P2B]

| Table | Key columns |
| --- | --- |
| `bill` | number, kind (`opd`, `ipd_interim`, `ipd_final`, `pharmacy`, `daycare`), encounter_id, patient_id, payer_id, tariff_id, status (`draft`, `final`, `cancelled`), bill_date, gross_paise, discount_paise, taxable_paise, cgst_paise, sgst_paise, round_off_paise, net_paise, payer_share_paise, patient_share_paise, paid_paise, balance_paise, finalized_by, finalized_at, cancel_reason_id, cancel_note, credit_note_id |
| `bill_line` | bill_id, seq, source (`service`, `package`, `pharmacy_sale_item`, `bed_charge`, `consumable`, `implant`), service_id, package_id, pharmacy_sale_item_id, description, description_hi, qty, unit_rate_paise, amount_paise, discount_paise, discount_reason_id, discount_approved_by, sac_hsn, gst_rate_bp, is_exempt, taxable_paise, cgst_paise, sgst_paise, inside_package bool, package_instance_id, payer_share_paise, patient_share_paise, is_non_payable bool (TPA), clinical_order_id, service_date, performed_by_doctor_id |
| `payment` | number (receipt), patient_id, encounter_id, bill_id nullable (deposits have none), kind (`payment`, `deposit`, `refund`, `deposit_adjustment`, `advance`), mode (`cash`, `upi`, `card`, `bank_transfer`, `cheque`, `payer_settlement`), amount_paise (refunds negative), upi_ref (UTR, optional), upi_payer_name, card_last4, card_auth_code, cheque_no, received_by, received_at, workstation_id, day_close_id, status (`valid`, `reversed`), reversed_by_payment_id, idempotency_key |
| `credit_note` | number, bill_id, amount_paise, reason_id, note, created_by, approved_by |
| `package` | code, name, name_hi, display_name_restricted (neutral name for MTP), department_id, room_category_id nullable, included_days, inclusions jsonb (service ids/categories with qty caps), exclusions jsonb, extra_day_service_id, is_active |
| `package_rate` | package_id, tariff_id, room_category_id, rate_paise, payer_package_code (HBP code for PM-JAY) |
| `package_instance` | encounter_id, package_id, package_rate_id, applied_at, applied_by, rate_paise, status |
| `day_close` | user_id (null for facility close), close_date, cash_expected_paise, cash_counted_paise, upi_expected_paise, card_expected_paise, difference_paise, difference_reason, closed_at, verified_by |
| `upi_reconciliation` | date, bank_statement_total_paise, system_total_paise, difference_paise, notes, done_by |

## 7. USG and legal [P2A]

| Table | Key columns |
| --- | --- |
| `usg_procedure` (master) | code, name, category (`obstetric`, `gynae`, `abdomen`, `pelvis`, `follicular`, `doppler`, `other`), requires_form_f_if_pregnant bool, default_template_id |
| `usg_template` | name, kind, fields schema jsonb (validated by zod; fetal-sex terms forbidden), print layout |
| `usg_study` | encounter_id, patient_id, pregnancy_id nullable, usg_procedure_id, clinical_order_id, scheduled_at, performed_by_doctor_id, machine_id, status (`ordered`, `in_progress`, `report_draft`, `signed`, `cancelled`), is_pregnant bool, ga_days_at_scan, findings jsonb, impression text, signed_at, form_f_id |
| `usg_machine` | make, model, serial_no, pcpndt_registration_ref, location, is_active |
| `form_f` | number, usg_study_id, patient_id, status (`draft`, `complete_unsigned`, `signed`, `submitted`), section data jsonb (validated by versioned zod schema `FormFv1`), doctor_declaration_signed_at, patient_declaration_document_id, signed_document_id, submitted_month, submitted_at, online_portal_ref |
| `pcpndt_monthly_report` | month, generated_at, file_id, submitted_at, submitted_by |
| `restricted.mtp_case` | patient_id, encounter_id, register_no, admission_date, ga_weeks, ga_days, indication_category, procedure_method, opinion_by_doctor_ids uuid[], opinion_form_document_id, consent_form_document_id, consent_by (`self`, `guardian`), guardian_details (only when required by law), outcome, discharge_date, complications, remarks |
| `restricted.mtp_monthly_report` | month, data jsonb, file_id, submitted_at |
| `birth_record` | mother_patient_id, newborn_patient_id, delivery_record_id, birth_at, sex (of baby — this is the BORN child, allowed), weight_g, birth_order, type (`single`, `twin`, `triplet`), place, attendant, reported_to_registrar_at, crs_reference |
| `death_record` / `stillbirth_record` | patient_id, at, cause_text, icd10, certified_by, reported_at, crs_reference |

## 8. Lab [P2A]

| Table | Key columns |
| --- | --- |
| `lab_test` | code, name, department (`haematology`, `biochemistry`, `serology`, `microbiology`, `clin_path`, `hormones`, `other`), sample_type, container, method, unit, result_type (`numeric`, `text`, `option`, `culture`, `formula`), formula, options jsonb, decimals, tat_hours, is_outsourced, outsource_lab, service_id |
| `lab_panel` / `lab_panel_item` | panels (CBC, LFT, KFT, ANC profile, etc.) |
| `lab_reference_range` | test_id, sex, age_min_days, age_max_days, pregnancy_trimester nullable, low, high, critical_low, critical_high, text_range |
| `lab_order` | number, encounter_id, patient_id, clinical_order_ids, status, priority |
| `lab_sample` | lab_order_id, barcode, sample_type, collected_at, collected_by, received_at, rejected_reason |
| `lab_result` | lab_sample_id, test_id, value_numeric, value_text, unit, flag (`L`,`H`,`LL`,`HH`,`N`), entered_by, entered_at, verified_by, verified_at, status (`pending`, `entered`, `verified`, `amended`) |
| `lab_report` | lab_order_id, version, released_at, released_by, document_id |

## 9. Pharmacy and inventory [P2A, implants P3]

| Table | Key columns |
| --- | --- |
| `store` | name, kind (`pharmacy`, `main`, `ot`, `labour_room`, `ward`, `icu`, `ccu`, `cath_lab`, `lab`), is_saleable, drug_licence_no, is_active |
| `item` | links to `drug` for medicines or standalone for consumables/implants: kind (`drug`, `consumable`, `implant`, `reagent`, `general`), drug_id nullable, name, hsn_code, gst_rate_bp, uom, pack_size, reorder_level, is_batch_tracked, is_expiry_tracked, is_serial_tracked (implants), price_cap_paise nullable (e.g. stents), is_active |
| `supplier` | name, gstin, drug_licence_no, address, phone, credit_days |
| `purchase_invoice` | supplier_id, store_id, invoice_no, invoice_date, grn_number, total_paise, tax_paise, status, is_consignment |
| `purchase_item` | purchase_invoice_id, item_id, batch_no, expiry (month precision), mfg_date, qty, free_qty, purchase_rate_paise, mrp_paise, sale_rate_paise, gst_rate_bp, discount_bp, serial_no (implants), udi_barcode |
| `stock_batch` | item_id, store_id, batch_no, expiry, mrp_paise, sale_rate_paise, purchase_rate_paise, serial_no, is_consignment, supplier_id, qty_on_hand (maintained by trigger from movements), status (`ok`, `blocked_expired`, `recalled`) |
| `stock_movement` | stock_batch_id, store_id, kind (`purchase`, `purchase_return`, `sale`, `sale_return`, `issue_ipd`, `return_ipd`, `transfer_out`, `transfer_in`, `adjust_plus`, `adjust_minus`, `expiry_write_off`, `consumption`), qty (+/-), ref_entity, ref_id, by_user, at, reason_id |
| `pharmacy_sale` | number, store_id, patient_id nullable (walk-in), encounter_id nullable, prescription_id nullable, doctor_id, kind (`opd`, `walk_in`, `ipd_issue`), payer_id, totals, status |
| `pharmacy_sale_item` | pharmacy_sale_id, item_id, stock_batch_id, qty, mrp_paise, rate_paise, discount_bp, gst_rate_bp, taxable, cgst, sgst, amount, returned_qty |
| `h1_register_entry` | pharmacy_sale_item_id, patient_name, patient_address, doctor_name, drug_name, qty, at (view or table populated by trigger) |
| `indent` / `indent_item` | from_store_id (ward), to_store_id (pharmacy/main), encounter_id nullable, status (`requested`, `partially_issued`, `issued`, `cancelled`) |
| `implant_usage` [P3] | encounter_id, procedure_id, item_id, stock_batch_id, serial_no, udi_barcode, size, qty, mrp_paise, billed_rate_paise, price_cap_paise, sticker_document_id |

## 10. IPD, OT, labour room, nursing [P2A]

| Table | Key columns |
| --- | --- |
| `ward` | name, kind (`general`, `private`, `semi_private`, `labour`, `nicu`, `icu`, `ccu`, `daycare`), floor |
| `room_category` | name, gst_applicable_above_paise (500000), is_icu bool, sort |
| `bed` | ward_id, room_category_id, code, status (`free`, `occupied`, `cleaning`, `blocked`, `reserved`), current_admission_id |
| `admission` | encounter_id (type ipd), admitted_at, admitting_doctor_id, consultant_doctor_ids, bed_id, room_category_id, provisional_diagnosis, admission_type (`planned`, `emergency`, `labour`, `daycare`, `transfer_in`), attendant_name, attendant_relation, attendant_mobile, mlc bool, mlc_no, expected_discharge_at, discharged_at, discharge_type (`normal`, `lama`, `dama`, `referred`, `death`, `absconded`), status |
| `bed_transfer` | admission_id, from_bed_id, to_bed_id, at, by_user, reason |
| `ipd_charge_rule` | service_id, trigger (`daily_at_time`, `on_admission`, `per_visit`), room_category_id, time_of_day, enabled |
| `ipd_order` | admission_id, kind (`medication`, `iv_fluid`, `investigation`, `diet`, `nursing`, `procedure`), drug_id, dose, route, frequency, start_at, stop_at, prn bool, instructions, ordered_by_doctor_id, entered_by, verified_by, status |
| `medication_administration` | ipd_order_id, scheduled_at, given_at, given_by, dose_given, status (`given`, `held`, `refused`, `missed`), note, stock_movement_id |
| `nursing_chart_entry` | admission_id, at, kind (`vitals`, `intake`, `output`, `note`, `handover`, `pain`, `lochia`, `fundal_height`, `wound`), data jsonb, by_user |
| `ot_schedule` | admission_id, ot_room, scheduled_start, surgeon_id, assistant_ids, anaesthetist_id, procedure_service_id, status |
| `ot_note` | ot_schedule_id, procedure_name, indication, anaesthesia_type, findings, steps, blood_loss_ml, specimens, complications, implants jsonb, start_at, end_at, signed_by, signed_at, who_checklist jsonb |
| `delivery_record` | admission_id, pregnancy_id, labour_onset (`spontaneous`, `induced`, `none`), mode (`nvd`, `assisted_vacuum`, `assisted_forceps`, `lscs_emergency`, `lscs_elective`, `vbac`), delivery_at, ga_weeks, episiotomy, perineal_tear_degree, placenta (`complete`, `incomplete`, `manual_removal`), blood_loss_ml, pph bool, oxytocin_given bool, baby_count, complications, conducted_by, signed_at |
| `newborn` | delivery_record_id, baby_patient_id, birth_order, sex_of_baby, weight_g, length_cm, head_circ_cm, apgar_1, apgar_5, resuscitation, outcome (`live`, `stillbirth_fresh`, `stillbirth_macerated`, `neonatal_death`), breastfeeding_initiated_at, vit_k_given, bcg_given, opv0_given, hepb0_given, nicu_admission bool |
| `partograph_entry` | delivery_record_id or admission_id, at, cervical_dilatation_cm, descent_fifths, contractions_per_10min, contraction_duration_s, fhr, liquor, moulding, maternal_pulse, bp, temp, oxytocin, drugs |
| `discharge_summary` | admission_id, template_kind, data jsonb, status (`draft`, `signed`, `amended`), signed_by, signed_at, document_id |

## 11. Payers and claims [P2B, P3]

| Table | Key columns |
| --- | --- |
| `preauth` | encounter_id, payer_id, coverage_id, external_ref (TMS case no / TPA ref), package_codes text[], requested_amount_paise, approved_amount_paise, status (`draft`, `submitted`, `query`, `approved`, `partially_approved`, `rejected`, `cancelled`, `enhancement_requested`), submitted_at, decided_at, query_text, query_due_at |
| `claim` | encounter_id, payer_id, preauth_id, external_ref, claimed_paise, approved_paise, settled_paise, deductions jsonb, status (`draft`, `submitted`, `query`, `approved`, `settled`, `rejected`, `appealed`), submitted_at, settled_at, utr |
| `claim_document` | preauth_id or claim_id, doc_type (`id_proof`, `pmjay_card`, `admission_photo`, `discharge_photo`, `investigation_report`, `ot_note`, `discharge_summary`, `bill`, `implant_sticker`, `other`), document_id, required bool, status |
| `payer_document_rule` | payer_id or payer_type, package_code nullable, doc_type, stage (`preauth`, `claim`), required |
| `corporate_employee` [P3] | payer_id, employee_id, name, relation, patient_id, valid_to |

## 12. Cardiology and critical care [P3]

| Table | Key columns |
| --- | --- |
| `cardiology_report` | encounter_id, kind (`ecg`, `echo`, `tmt`, `holter`, `abpm`), data jsonb, document_id (ECG image/PDF), impression, signed_by, signed_at |
| `icu_flowsheet_entry` | admission_id, at, vitals jsonb, ventilator jsonb, infusions jsonb, gcs, intake_ml, output_ml, lines jsonb, scores jsonb, by_user |
| `cath_procedure` | admission_id, kind (`cag`, `ptca`, `ppi`, `bmv`, `other`), access_site, operators, findings jsonb (vessel-wise), intervention jsonb, contrast_ml, fluoro_time_min, complications, start_at, end_at, signed_by |

## 13. Messaging and integration

| Table | Key columns |
| --- | --- |
| `message_template` | channel (`whatsapp`, `sms`), provider_template_name, language, kind (`rx`, `receipt`, `bill`, `lab_report`, `anc_reminder`, `vaccine_reminder`, `follow_up`, `discharge`), body_preview, variables, is_approved |
| `message_outbox` | patient_id, to_mobile, template_id, variables jsonb, document_id, status (`queued`, `sent`, `delivered`, `read`, `failed`, `opted_out`), attempts, last_error, provider_message_id, send_after |
| `patient_consent` | patient_id, kind (`whatsapp`, `data_processing`, `abdm_share`), granted bool, at, captured_by, method (`verbal_recorded`, `signed`, `otp`) |
| `integration_event` | system (`abdm`, `nhcx`, `lab_analyser`), direction, payload jsonb, status, attempts |

## 14. Indexes (minimum)

- `patient`: unique `uhid`; btree `mobile`; GIN trigram `search_name_norm`, `search_name_phonetic`.
- `encounter`: (`patient_id`, `started_at desc`), (`doctor_id`, `started_at`).
- `opd_token`: unique (`doctor_id`, `token_date`, `token_no`); (`token_date`, `queue_state`).
- `bill`: unique `number`; (`patient_id`, `bill_date`); (`status`, `bill_date`).
- `payment`: (`received_by`, `received_at`); (`day_close_id`).
- `stock_batch`: (`item_id`, `store_id`, `expiry`).
- `lab_sample`: unique `barcode`.
- `pregnancy`: (`patient_id`) where status = 'active' (partial unique: one active pregnancy per patient).

## 15. Key invariants (enforce with constraints/triggers + tests)

1. `bill.net_paise = gross - discount + cgst + sgst + round_off`; `payer_share + patient_share = net`.
2. A `final` bill cannot change; only a credit note or cancellation.
3. `stock_batch.qty_on_hand >= 0` (sales cannot exceed stock; transaction fails).
4. Only one `active` pregnancy per patient.
5. `usg_study` with `is_pregnant = true` cannot reach `signed` unless linked `form_f.status in ('signed','submitted')`.
6. `restricted.*` tables are inaccessible to roles without the permission (RLS).
7. `bed.current_admission_id` set iff `status = 'occupied'`.
8. `payment.kind = 'refund'` → amount negative and approval recorded.
