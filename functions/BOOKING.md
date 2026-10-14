# Clinic booking status

The resident map subscribes to appointments where resident_uid equals the signed-in UID, then selects active records with the chosen clinic_id. The submission preflight and createBooking callable query both resident_uid and clinic_id. No booking enables Book Appointment; pending disables it; confirmed (the clinic acceptance status), accepted, approved or in_progress displays the schedule. Completed, cancelled, declined and expired records do not block. Confirmed records remain active until 90 minutes after their scheduled Manila time. Recorded arrivals remain active while intake/treatment is in progress. See APPOINTMENT-LIFECYCLE.md for cleanup and permanent patient records.

createBooking uses a transaction and a server-only _booking_locks document per resident/clinic. Concurrent creation attempts serialize on this document, and the query also finds older bookings that have no lock. Firestore rules deny direct resident appointment writes. Confirmation and arrival use manageAppointment; residents use cancelBooking and rescheduleBooking. No data backfill is needed.

Residents can cancel or request a reschedule from the dashboard, Appointments tab, or clinic map. Cancellation requires a reason. Each cancellation or reschedule writes a clinic staff notification in the same server transaction as the appointment change and reservation release. Notifications include clinic_id so all approved staff of that clinic receive the update, including clinics without a stored staff UID. Clinic Notifications displays appointment updates alongside expiry reminders, and its navigation badge includes unread appointment updates. Staff may mark updates as read; notification content is immutable to clients.

Pending and confirmed appointments can be rescheduled while active, before recorded arrival, within the existing original-date/next-day limit. A reschedule clears confirmation and the arrival deadline, releases any held stock, and returns the appointment to pending. Staff see a reschedule request and must confirm it again through manageAppointment. Cancellation retries and repeated submissions of the same pending reschedule do not duplicate notifications or release reservations twice. Cancelled bookings remain visible in the resident's past appointments.

Residents can submit all pending clinic-recommended dates through createBatchBooking. The callable validates the treatment schedule, clinic hours, date order, active bookings and slot capacity, then creates or updates the complete course in one Firestore transaction. If any dose fails validation or a slot is full, none of the batch is written. Doses already in progress are retained rather than booked again.

Schedule recommendation notifications are stored in-app and sent to registered web-push tokens by sendVaccinationSchedulePush. Push requires HTTPS, a supported browser, Firebase Web Push configured for the project, and resident permission on each device. The dashboard prompts residents to enable alerts; the same in-app notification remains available without push.

Deployment: deploy functions:createBooking, functions:createBatchBooking, functions:cancelBooking, functions:rescheduleBooking, functions:manageAppointment, functions:manageTreatment, functions:sendVaccinationSchedulePush and functions:expireAppointments with hosting and firestore:rules. Hosting must include firebase-web-config.js and firebase-messaging-sw.js at the site root so the service worker can receive push alerts. See APPOINTMENT-LIFECYCLE.md. Old cached clients cannot create directly once the rules are deployed; refresh them.

Validation: node --test functions/appointment-changes.test.js functions/appointment-changes-ui.test.js functions/batch-booking.test.js functions/booking.test.js functions/reschedule-booking.test.js functions/appointment-lifecycle.test.js functions/booking-ui.test.js. These unit tests model transaction serialization and UI behavior; they do not replace Firestore emulator or live integration testing.

## Vaccine reservations

Confirming a pending appointment atomically reserves one dose from the earliest-expiring usable batch that remains valid after the appointment date. Inventory quantity represents physical doses for batches marked quantity_mode: on_hand; reserved_count tracks held doses, and availability subtracts those reservations. Legacy batches are converted when confirming an appointment. The appointment stores the batch and reservation status. Confirmation updates the clinic stock summary in the same transaction, and the resident map derives availability directly from live inventory snapshots.

For example, with 50 physical doses, accepting one appointment leaves inventory at 50 and shows 49 doses available in Clinic Status Overview. Arrival and intake keep those counts unchanged. Completing the dose reduces physical inventory to 49 and consumes the reservation, so the overview remains at 49. Cancelling before completion releases the reservation and restores availability to 50. The map and dose-completion selector share the same available-stock calculation; fully reserved batches can only be used by the appointment holding that reservation.

New single bookings, batch bookings and rescheduling are permitted when usable unreserved stock is positive, including Low Stock clinics (1–15 doses). Guests receive a low-stock confirmation before continuing to sign-in; residents receive a confirmation before submitting a booking, batch booking or reschedule at a Low Stock clinic. Out of Stock clinics remain blocked. Booking requests do not reserve stock; staff confirmation reserves a usable dose atomically, so confirmations cannot overdraw stock.

Clinical completion consumes the appointment reservation, records the actual administration date and vaccine batch, and marks the dose completed and deducts one physical dose. Legacy reservations already deducted at confirmation consume their reservation without another deduction. Appointments confirmed before this feature retain the legacy completion-time deduction. Existing confirmations are not backfilled automatically.

Cancellation uses cancelBooking to release reservations atomically. Expiry and rescheduling also release unconsumed reservations exactly once. Batches with reservations cannot be deleted, archived, or have their identifying fields changed through browser writes. Quantity adjustments record physical doses on hand and cannot reduce stock below the reserved count.

Clinic stock summaries are server-maintained. The refreshInventoryStock trigger recomputes availability from current inventory for additions, quantity adjustments, archives and deletions, including event retries and events delivered out of order. Browser inventory rendering no longer writes stock summaries, and Firestore rules reject client changes to those derived fields. Confirmation, completion and reservation release still publish their summaries atomically; the resident map uses inventory snapshots for immediate availability updates.

Deploy functions:refreshInventoryStock with the updated appointment/treatment functions, firestore.rules, and frontend together. New cancellation and reservation behavior requires these backend changes; JavaScript unit tests do not substitute for a Firebase emulator or deployed integration check.

## Deploying the low-stock booking fix

The message "This clinic has low vaccine stock. Choose another clinic." comes from the old server booking rule. Updating or refreshing the frontend alone cannot remove that restriction. Deploy every callable that uses the shared stock check, along with the updated warning UI:

```powershell
firebase deploy --only "functions:createBooking,functions:createBatchBooking,functions:rescheduleBooking,functions:getPublicClinicStock,hosting"
```

After deployment, refresh the page and book a clinic with 1–15 available doses. Cancelling the warning must create no appointment; choosing Book Anyway must create a pending request. A clinic with zero available doses must remain blocked.

## Guest vaccine availability

Guest maps call getPublicClinicStock to calculate current usable, unreserved inventory instead of trusting potentially stale clinic profile stock_total values. The callable returns only clinic IDs, available totals, stock status, vaccine summaries and vaccine types. Inventory batch details and staff information remain protected by the existing database rules. Guest pages refresh on clinic updates, every 30 seconds while visible, and on window focus. Failed requests show availability as unavailable rather than displaying an old profile total as current. Signed-in residents retain their live inventory listener.

Deploy the getPublicClinicStock function before or together with the updated hosting files: `firebase deploy --only functions:getPublicClinicStock,hosting`. Validate the calculation with `node --test functions/public-clinic-stock.test.js functions/inventory-stock.test.js functions/dose-stock.test.js`, then check the deployed guest and resident maps with the same clinic. Guest refreshes are periodic, so a change can take up to 30 seconds to appear when no clinic profile update arrives.
