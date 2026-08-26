import { auth, db, fetchUserProfile } from './firebase.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js';
import { doc, onSnapshot, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';

const defaultAnimals = [
  { name: 'Dog', percent: 68 }, { name: 'Cat', percent: 20 },
  { name: 'Bat', percent: 8 }, { name: 'Others', percent: 4 }
];
const defaultAnalytics = {
  monthlyCases: [12, 18, 15, 22, 19, 24, 17],
  monthlyVaccinations: [45, 62, 55, 80, 72, 95, 53],
  barangays: [{ name: 'Mamatid', cases: 32 }, { name: 'Banlic', cases: 26 }, { name: 'Pulo', cases: 19 }, { name: 'Sala', cases: 16 }, { name: 'Marinig', cases: 11 }, { name: 'Niugan', cases: 9 }, { name: 'Butong', cases: 7 }, { name: 'Poblacion Uno', cases: 7 }],
  caseTrend: [38, 57, 47, 69, 60, 75, 53],
  ageGroups: [18, 24, 33, 27, 13]
};

document.querySelectorAll('[data-edit-form]').forEach(button => {
  button.addEventListener('click', () => {
    const form = document.getElementById(button.dataset.editForm);
    form.hidden = !form.hidden;
    document.querySelectorAll(`[data-edit-form="${button.dataset.editForm}"]`).forEach(editButton => {
      editButton.innerHTML = form.hidden ? '<i class="fa-solid fa-pencil"></i>' : '<i class="fa-solid fa-xmark"></i>';
      editButton.setAttribute('aria-label', form.hidden ? 'Edit analytics data' : 'Close analytics editor');
    });
  });
});

function fillAnimalForm(data) {
  const animals = data.animals || defaultAnimals;
  animals.forEach((animal, index) => {
    document.getElementById(`animalName${index + 1}`).value = animal.name || '';
    document.getElementById(`animalPercent${index + 1}`).value = animal.percent ?? 0;
  });
}

onAuthStateChanged(auth, async user => {
  if (!user) return;
  const profile = await fetchUserProfile(user.uid);
  if (profile?.role !== 'admin' && profile?.role !== 'administrator') return;
  onSnapshot(doc(db, 'system_settings', 'animal_exposure'), snapshot => fillAnimalForm(snapshot.exists() ? snapshot.data() : {}));
  onSnapshot(doc(db, 'system_settings', 'dashboard_analytics'), snapshot => {
    const data = snapshot.exists() ? snapshot.data() : {};
    fillAnalyticsForm(data);
    if (window.adminMonthlyChart) {
      window.adminMonthlyChart.data.datasets[0].data = data.monthlyCases || defaultAnalytics.monthlyCases;
      window.adminMonthlyChart.data.datasets[1].data = data.monthlyVaccinations || defaultAnalytics.monthlyVaccinations;
      window.adminMonthlyChart.update();
    }
  });
});

function csvNumbers(value) {
  return value.split(',').map(item => Number(item.trim()));
}

function fillAnalyticsForm(data) {
  const values = { ...defaultAnalytics, ...data };
  document.getElementById('monthlyCases').value = (values.monthlyCases || defaultAnalytics.monthlyCases).join(', ');
  document.getElementById('monthlyVaccinations').value = (values.monthlyVaccinations || defaultAnalytics.monthlyVaccinations).join(', ');
  document.getElementById('barangayNames').value = (values.barangays || defaultAnalytics.barangays).map(item => item.name).join(', ');
  document.getElementById('barangayCases').value = (values.barangays || defaultAnalytics.barangays).map(item => item.cases).join(', ');
  document.getElementById('caseTrendValues').value = (values.caseTrend || defaultAnalytics.caseTrend).join(', ');
  document.getElementById('ageGroupCounts').value = (values.ageGroups || defaultAnalytics.ageGroups).join(', ');
}

document.getElementById('animalExposureForm').addEventListener('submit', async event => {
  event.preventDefault();
  const message = document.getElementById('animalExposureFormMessage');
  const status = document.getElementById('animalExposureSaveStatus');
  const animals = [1, 2, 3, 4].map(index => ({
    name: document.getElementById(`animalName${index}`).value.trim(),
    percent: Number(document.getElementById(`animalPercent${index}`).value)
  }));
  if (animals.some(animal => !animal.name) || animals.reduce((total, animal) => total + animal.percent, 0) !== 100) {
    message.textContent = 'Use four animal names and make the percentages total exactly 100.';
    message.style.color = '#b91c1c';
    return;
  }
  try {
    await setDoc(doc(db, 'system_settings', 'animal_exposure'), { animals, updated_at: serverTimestamp() }, { merge: true });
    message.textContent = 'Animal exposure data saved. Residents will see the update automatically.';
    message.style.color = '#15803d';
    status.textContent = 'Saved';
  } catch (error) {
    message.textContent = `Could not save animal exposure data: ${error.message}`;
    message.style.color = '#b91c1c';
  }
});

document.getElementById('dashboardAnalyticsForm').addEventListener('submit', async event => {
  event.preventDefault();
  const message = document.getElementById('dashboardAnalyticsMessage');
  const status = document.getElementById('dashboardAnalyticsSaveStatus');
  const monthlyCases = csvNumbers(document.getElementById('monthlyCases').value);
  const monthlyVaccinations = csvNumbers(document.getElementById('monthlyVaccinations').value);
  const names = document.getElementById('barangayNames').value.split(',').map(item => item.trim()).filter(Boolean);
  const cases = csvNumbers(document.getElementById('barangayCases').value);
  const caseTrend = csvNumbers(document.getElementById('caseTrendValues').value);
  const ageGroups = csvNumbers(document.getElementById('ageGroupCounts').value);
  if (monthlyCases.length !== 7 || monthlyVaccinations.length !== 7 || caseTrend.length !== 7 || ageGroups.length !== 5 || names.length !== cases.length || [monthlyCases, monthlyVaccinations, cases, caseTrend, ageGroups].some(values => values.some(value => !Number.isFinite(value) || value < 0))) {
    message.textContent = 'Enter 7 monthly cases, 7 vaccinations, 7 trend values, 5 age counts, and matching barangay names/cases.';
    message.style.color = '#b91c1c';
    return;
  }
  try {
    await setDoc(doc(db, 'system_settings', 'dashboard_analytics'), { monthlyCases, monthlyVaccinations, barangays: names.map((name, index) => ({ name, cases: cases[index] })), caseTrend, ageGroups, updated_at: serverTimestamp() }, { merge: true });
    message.textContent = 'Dashboard analytics saved. Public and resident dashboards will update automatically.';
    message.style.color = '#15803d';
    status.textContent = 'Saved';
  } catch (error) {
    message.textContent = `Could not save dashboard analytics: ${error.message}`;
    message.style.color = '#b91c1c';
  }
});
