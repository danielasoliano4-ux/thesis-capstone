# Appointment arrival and intake

Residents select a clinic from the map/directory and submit only Preferred Date and Preferred Time. Account identity comes from the authenticated profile. Pending requests reach the staff dashboard through its existing Firestore listener.

Staff confirmation calls manageAppointment, which derives the schedule in Asia/Manila time. Early arrival is accepted from midnight on the appointment date in Asia/Manila (inclusive) until 90 minutes after the scheduled time (exclusive). For 9:00 AM the deadline is 10:30 AM, regardless of when staff approved the booking. Staff cannot confirm an already lapsed appointment. Pending requests are not deleted by this rule.

expireAppointments runs each minute, scans confirmed appointments in pages, and transactionally rechecks status and arrival before deletion. Physical deletion happens on the next successful scheduler run, not necessarily at the exact deadline; the callable always enforces the exact deadline. Existing confirmed appointments with parseable date/time follow the same policy. Malformed legacy schedules are preserved for manual review.

Mark Arrived changes status to in_progress before opening intake, so closing the form does not lose arrival. Complete Intake resumes the form. Submission validates all seven fields and atomically creates patient_records/{appointmentId}, copies intake to the appointment for existing patient views, and stamps intake_completed_at. Repeated submissions cannot overwrite the permanent record. Residents read their own records and staff read records belonging to their clinic. Both portals use live listeners. Intake completion is separate from vaccine administration; Complete Dose remains available after intake.

Deploy functions:createBooking,functions:rescheduleBooking,functions:manageAppointment,functions:expireAppointments together with firestore:rules and hosting after review. The local code is not live until deployed. This changes cleanup for existing confirmed bookings too. Firebase scheduled-function documentation: https://firebase.google.com/docs/functions/schedule-functions

Validation: node --test functions/booking.test.js functions/appointment-lifecycle.test.js. Unit transaction doubles cover deadlines, authentication, intake validation, pagination and serialized cleanup/arrival; they do not replace a deployed or emulator integration test. Smoke test with a resident and clinic staff: book, see pending live, confirm, mark arrival during the window, save intake, and verify the same record in staff Patient Records and resident Booking Records. Test a separate no-show through the next scheduler run.

## Clinic operating hours

Booking and rescheduling generate 30-minute slots from the clinic weekdayHours/weekendHours fields (or legacy hours). Opening time is included; closing time is excluded. 24-hour clinics offer 00:00 through 23:30. Overnight shifts include their next-day continuation; comma/semicolon-separated ranges support breaks. Missing or unparseable hours do not invent a default schedule and show a contact-clinic message. Accepted examples: 5:00 AM - 5:00 PM, 05:00 - 17:00, 24 hours, 24/7, Closed.

All dates/times use Asia/Manila. Only times strictly later than the current instant are selectable. Open dialogs refresh every second without rebuilding unchanged options. The server rechecks the current saved clinic hours and current time inside the booking/rescheduling transaction. Direct resident rescheduling writes are disabled by rules; rescheduleBooking validates the same constraints and the existing original-date/next-day limit.

The pure logic in functions/clinic-hours.js and scripts/clinic-hours.js is mirrored for the separate deployment roots; a parity test prevents drift. Run node --test functions/booking.test.js functions/appointment-lifecycle.test.js functions/booking-ui.test.js functions/clinic-hours.test.js functions/reschedule-booking.test.js. Deploy the new rescheduleBooking function alongside createBooking, hosting and firestore:rules before using the updated screens.

## Intake animal analytics

Exposure choices match Patient Tracking. Animal choices are Dog, Cat and Other; Other requires a specific animal name, saved as animal_type. Saving intake atomically rebuilds system_settings/animal_exposure from permanent patient records, counting each course once and grouping custom animals as Other. Public and resident charts listen to this document without requiring an admin dashboard session. The first intake saved after deployment populates the summary, including existing patient records. This currently scans patient records per intake; larger datasets should migrate to incremental aggregation. Deploy manageAppointment and the updated frontend together.


Pending appointment expiry: unconfirmed requests expire at their scheduled Asia/Manila time. The expireAppointments job persists expired status every minute in a transaction, retaining the original document. Late confirmation is rejected before the job runs. Resident history includes expired records and Book Again creates a new request through the existing booking flow. Clinic expired entries have disabled actions. Deploy functions, Firestore rules and hosting together.

## Smart Auto-Fill & Review

After arrival, the intake dialog calls manageAppointment with action intake_context. The callable checks active staff membership in the appointment clinic and requires a recorded arrival before retrieving the linked resident history. It returns only intake defaults, mode and missing fields. Permanent records, prior appointments, vaccination records and the resident profile supply missing demographics; exposure fields come only from the current vaccination session (missing session IDs use legacy). A different session reuses demographics without copying a previous exposure. Age is recalculated from date of birth. Staff review and save a new permanent appointment intake; historical records remain unchanged. Failed lookup disables submission and offers Retry lookup. Deploy manageAppointment and Hosting together; this client requires the updated callable.
