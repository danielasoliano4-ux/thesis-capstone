# Clinic booking status

The resident map subscribes to appointments where resident_uid equals the signed-in UID, then selects active records with the chosen clinic_id. The submission preflight and createBooking callable query both resident_uid and clinic_id. No booking enables Book Appointment; pending disables it; confirmed (the clinic acceptance status), accepted, approved or in_progress displays the schedule. Completed, cancelled, declined and expired records do not block. Confirmed records remain active until 90 minutes after their scheduled Manila time. Recorded arrivals remain active while intake/treatment is in progress. See APPOINTMENT-LIFECYCLE.md for cleanup and permanent patient records.

createBooking uses a transaction and a server-only _booking_locks document per resident/clinic. Concurrent creation attempts serialize on this document, and the query also finds older bookings that have no lock. Firestore rules deny direct client appointment creation; confirmation and arrival use the manageAppointment callable; cancellation and dose completion use restricted update rules. No data backfill is needed.

Deployment: deploy functions:createBooking, functions:rescheduleBooking, functions:manageAppointment and functions:expireAppointments with hosting and firestore:rules. See APPOINTMENT-LIFECYCLE.md. The new browser code requires this function. Old cached clients cannot create directly once the rules are deployed; refresh them. Other local changes included in hosting/rules should be reviewed before publishing.

Validation: node --test functions/booking.test.js. These unit tests model transaction serialization; they do not replace Firestore emulator or live integration testing.
