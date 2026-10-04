# Patient vaccination treatment

Deploy functions, Firestore rules, and hosting together. No deployment is performed by the implementation task.

The server derives treatment identity from existing patient appointments/history, never from a client-supplied dose or session. Existing session IDs are preserved; records without a session use legacy. Treatments are materialized when booking, administering, verifying, or reviewing schedules. Prior records remain immutable. Historical records with conflicting session IDs need staff/data review; this change does not merge separate exposure courses.

The existing five-dose Day 0/3/7/14/28 application schedule remains the default. This is not a new clinical protocol. Staff can change incomplete recommended dates after documenting clinical review; appointment dates and actual administration dates are separate. No missed-date or clinic-change operation creates a new treatment. Completed courses require a separate clinical assessment; this flow does not automatically start another course.

manageTreatment checks active approved receiving-clinic staff, rereads patient history in a transaction, and serializes updates through the treatment document. Completion writes stock, permanent record, appointment, treatment, and notification together. External verification accepts optional vaccine information and documentation. Supplied cards are checked against the treatment and Storage object; without a card, staff must document a clinical verification basis. Verified external Dose 1 anchors recommended dates to Day 0, 3, 7, 14, and 28; dates explicitly reviewed by staff take precedence. Verifier, source and evidence remain in the continuous treatment history without consuming clinic stock. Only administered verified records count toward progress.

refreshOverdueDoses runs daily at 00:05 Asia/Manila. Review/booking recalculate overdue status immediately; the patient display refreshes each minute. It never moves recommended dates automatically.

Run: node --test functions/treatment.test.js functions/booking.test.js functions/reschedule-booking.test.js functions/appointment-lifecycle.test.js functions/dose-stock.test.js functions/booking-ui.test.js

Before production rollout, verify callable authentication, Firestore rules, uploaded-card access, and both staff screens against a Firebase emulator or staging project. Local unit tests do not replace that integration check.
