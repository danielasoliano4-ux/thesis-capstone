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

			const batch = db.batch();
			let expiredCount = 0;
			for (const appointmentDoc of snapshot.docs) {
				if (!appointmentDoc.data().reservation_end_date || appointmentDoc.data().reservation_end_date >= today) continue;
				batch.update(appointmentDoc.ref, {
					status: 'expired',
					expired_at: admin.firestore.FieldValue.serverTimestamp(),
					expiration_reason: 'Reservation duration ended'
				});
				expiredCount++;
			}
			if (expiredCount) await batch.commit();
		}
	);

// Create and deploy your first functions
// https://firebase.google.com/docs/functions/get-started

// exports.helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });
