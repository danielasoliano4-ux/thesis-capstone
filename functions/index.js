/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

const { setGlobalOptions } = require('firebase-functions');
const admin = require('firebase-admin');
const sgMail = require('@sendgrid/mail');
const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');

// For cost control, you can set the maximum number of containers that can be
// running at the same time. This helps mitigate the impact of unexpected
// traffic spikes by instead downgrading performance. This limit is a
// per-function limit. You can override the limit for each function using the
// `maxInstances` option in the function's options, e.g.
// `onRequest({ maxInstances: 5 }, (req, res) => { ... })`.
// NOTE: setGlobalOptions does not apply to functions using the v1 API. V1
// functions should each use functions.runWith({ maxInstances: 10 }) instead.
// In the v1 API, each function can only serve one request per container, so
// this will be the maximum concurrent request count.
setGlobalOptions({ maxInstances: 10 });

admin.initializeApp();

const db = admin.firestore();
const sendGridApiKey = defineSecret('SENDGRID_API_KEY');
const senderEmail = 'danisoliano762@gmail.com';

function configureEmail() {
	sgMail.setApiKey(sendGridApiKey.value());
}

function buildAppointmentEmail(appointment, subject, heading, message) {
	return {
		to: appointment.resident_email,
		from: senderEmail,
		subject,
		html: `
			<div style="font-family:Arial,sans-serif;line-height:1.6;">
				<h2>${heading}</h2>
				<p>Hello ${appointment.resident_name || 'Resident'},</p>
				<p>${message}</p>
				<p>
					<strong>Clinic:</strong> ${appointment.clinic_name || 'Not provided'}<br>
					<strong>Date:</strong> ${appointment.preferred_date || 'Not provided'}<br>
					<strong>Time:</strong> ${appointment.preferred_time || 'Not provided'}<br>
					<strong>Dose:</strong> ${appointment.dose_label || 'Not provided'}
				</p>
				<p>Please bring your vaccination card and arrive on time.</p>
			</div>
		`
	};
}

exports.sendAppointmentConfirmation = onDocumentUpdated(
	{
		document: 'appointments/{appointmentId}',
		secrets: [sendGridApiKey]
	},
	async event => {
		const before = event.data.before.data();
		const after = event.data.after.data();

		if (before.status === 'confirmed' || after.status !== 'confirmed') return;
		if (!after.resident_email) return;

		configureEmail();
		await sgMail.send(buildAppointmentEmail(
			after,
			'Your anti-rabies appointment is confirmed',
			'Appointment Confirmed',
			'Your anti-rabies vaccination appointment has been confirmed by the clinic.'
		));
	}
);

// Inclusive reservation window: a duration of N days keeps an appointment valid
// through the (N-1)th day after its scheduled date.
const DEFAULT_RESERVATION_DAYS = 1;
const MAX_RESERVATION_DAYS = 7;

function addDaysToDateString(dateString, daysToAdd) {
	const parts = String(dateString || '').split('-').map(Number);
	if (parts.length !== 3 || parts.some(value => Number.isNaN(value))) return '';
	const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
	date.setUTCDate(date.getUTCDate() + Number(daysToAdd || 0));
	return date.toISOString().split('T')[0];
}

async function getReservationDaysFor(clinicId) {
	if (!clinicId) return DEFAULT_RESERVATION_DAYS;
	try {
	const clinic = await db.collection('clinics').doc(clinicId).get();
	const days = Number(clinic.data()?.reservation_days);
	if (!Number.isFinite(days) || days < 1) return DEFAULT_RESERVATION_DAYS;
	return Math.min(MAX_RESERVATION_DAYS, Math.floor(days));
	} catch (error) {
	console.error('Could not read reservation duration for clinic', clinicId, error);
	return DEFAULT_RESERVATION_DAYS;
	}
}

function getManilaDate(daysFromNow = 0) {
	const date = new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000);
	return new Intl.DateTimeFormat('en-CA', {
		timeZone: 'Asia/Manila',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).format(date);
}

exports.sendAppointmentReminders = onSchedule(
	{
		schedule: '0 8 * * *',
		timeZone: 'Asia/Manila',
		secrets: [sendGridApiKey]
	},
	async () => {
		configureEmail();
		const tomorrow = getManilaDate(1);
		const snapshot = await db.collection('appointments')
			.where('status', '==', 'confirmed')
			.where('preferred_date', '==', tomorrow)
			.get();

		for (const appointmentDoc of snapshot.docs) {
			const appointment = appointmentDoc.data();
			if (!appointment.resident_email || appointment.reminder_sent) continue;

			await sgMail.send(buildAppointmentEmail(
				appointment,
				'Vaccination appointment reminder',
				'Appointment Reminder',
				'Your anti-rabies vaccination appointment is scheduled for tomorrow.'
			));

			await appointmentDoc.ref.update({
				reminder_sent: true,
				reminder_sent_at: admin.firestore.FieldValue.serverTimestamp()
			});
		}
	}
);

exports.expireAppointments = onSchedule(
		{
			schedule: '0 * * * *',
			timeZone: 'Asia/Manila'
		},
		async () => {
				const today = getManilaDate();
			const snapshot = await db.collection('appointments')
			.where('status', '==', 'confirmed')
			.get();

			let expiredCount = 0;
			for (const appointmentDoc of snapshot.docs) {
			const appointment = appointmentDoc.data();
			const endDate = appointment.reservation_end_date;
			// Prefer the stored window. When an older appointment never had one
			// written, derive it from the clinic setting (or the system default)
			// so unfulfilled schedules cannot stay active forever.
			let effectiveEnd = endDate;
			if (!effectiveEnd) {
			const days = await getReservationDaysFor(appointment.clinic_id);
				effectiveEnd = addDaysToDateString(appointment.preferred_date, days - 1);
			if (!effectiveEnd) continue;
			}
			// The end date is inclusive, so the appointment is only lapsed once
			// today is strictly past it.
			if (effectiveEnd >= today) continue;
			appointmentDoc.ref.update({
			status: 'expired',
				expired_at: admin.firestore.FieldValue.serverTimestamp(),
				expiration_reason: 'Reservation duration ended - resident did not attend',
			reservation_end_date: effectiveEnd
			});
				expiredCount++;
			}
			if (expiredCount) console.log(`Expired ${expiredCount} unfulfilled appointment(s).`);
		}
	);

// Account lifecycle operations must run with the Admin SDK. Keeping these out
// of the browser prevents an administrator from accidentally creating a user
// profile that has no corresponding Firebase Authentication account.
exports.manageUserAccount = onCall(async request => {
	if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
	const requester = await db.collection('users').doc(request.auth.uid).get();
	if (!['admin', 'administrator'].includes(requester.data()?.role)) throw new HttpsError('permission-denied', 'Administrator access is required.');
	const { action, uid, email, password, profile = {} } = request.data || {};
	if (action === 'create') {
		if (!email || !password || password.length < 6) throw new HttpsError('invalid-argument', 'Email and a password of at least 6 characters are required.');
		const user = await admin.auth().createUser({ email, password, displayName: profile.full_name || profile.username || undefined, disabled: false });
		await db.collection('users').doc(user.uid).set({ email, role: profile.role || 'resident', is_active: true, created_at: admin.firestore.FieldValue.serverTimestamp(), updated_at: admin.firestore.FieldValue.serverTimestamp(), ...profile });
		return { uid: user.uid };
	}
	if (!uid) throw new HttpsError('invalid-argument', 'A user id is required.');
	if (action === 'update') {
		const allowed = ['full_name', 'username', 'role', 'clinic_id', 'clinic_name', 'is_active', 'approval_status', 'status'];
		const changes = Object.fromEntries(Object.entries(profile).filter(([key]) => allowed.includes(key)));
		await db.collection('users').doc(uid).set({ ...changes, updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
		return { uid };
	}
	if (action === 'delete') {
		if (uid === request.auth.uid) throw new HttpsError('failed-precondition', 'You cannot delete your own administrator account.');
		await admin.auth().deleteUser(uid);
		await db.collection('users').doc(uid).delete();
		return { uid };
	}
	throw new HttpsError('invalid-argument', 'Unsupported account action.');
});

// Create and deploy your first functions
// https://firebase.google.com/docs/functions/get-started

// exports.helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });
