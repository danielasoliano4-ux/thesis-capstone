const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSummary } = require('./live-analytics');
test('permanent intake and later doses retain WHO category and count one course', () => {
 const base={resident_uid:'r',vaccination_session_id:'s'};
 const intake={...base,id:'p',patient_category:'Category III',bite_date:'2026-04-01',date_of_birth:'2000-01-01',animal_type:'Dog'};
 const appointments=[{...base,id:'a',preferred_date:'2026-04-02',status:'completed'}];
 const doses=[1,2,3,4,5].map(n=>({...base,id:'v'+n,dose_number:n,date_given:'2026-04-0'+n}));
 const result=buildSummary(appointments,doses,[intake],[{id:'r',barangay:'Banlic'}],2026);
 assert.equal(result.totalCases,1);
 assert.equal(result.completed,1);
 assert.equal(result.publicRecords[0].category,'Category III');
 assert.equal(result.publicRecords[0].severity,'High');
 assert.equal(result.monthlyCases[3],1);
 assert.deepEqual(result.ageGroups,[0,0,1,0,0]);
 assert.equal(result.year,2026);
 assert.equal(buildSummary([],doses,[intake],[],2026).publicRecords[0].category,'Category III');
});
test('missing category remains unknown and empty summaries clear all months', () => {
 const result=buildSummary([{id:'a',resident_uid:'r',preferred_date:'2026-05-01'}],[],[],[],2026);
 assert.equal(result.publicRecords[0].category,'Not recorded');
 assert.equal(result.publicRecords[0].severity,'Unknown');
 assert.deepEqual(buildSummary([],[],[],[],2026).monthlyCases,Array(12).fill(0));
});
