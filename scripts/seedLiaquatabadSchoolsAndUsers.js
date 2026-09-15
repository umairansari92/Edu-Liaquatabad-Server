/**
 * 🏛️ SEED SCRIPT: LIAQUATABAD TOWN CENTRE (DMC) COMPREHENSIVE DATASET
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Seeds:
 * 1. Exactly 15 Schools (from official DMC Liaquatabad Town institutional register):
 *    - Shibli Nomani English Medium School
 *    - Baba E Urdu Molvi Abdul Haq English Medium School
 *    - Grand Citizen Girls Primary School LT 12-P
 *    - Muslim Pilot Girls Primary School
 *    - Huma Boys Primary School LT 19-P
 *    - Moulana Muhammad Husain Azad G/ P ENGLISH MEDIUM SCHOOL LT 17 (P)
 *    - MOLANA MUHAMMAD HUSSAIN AZAD LT-18P
 *    - MOULANA MUHAMMAD HUSSAIN AZAD BOYS SECONDARY SCHOOL (LT-4S)
 *    - MOLANA FAZAL UL HAQ ELEMENTARY SCHOOL
 *    - BEGUM RANA LIAQUAT ALI KHAN ENGLISH MEDIUM SCHOOL
 *    - BEGUM RA'ANA LIAQUAT ALI KHAN GIRLS SECONDARY SCHOOL
 *    - Grammar Girls Primary School LT-16 P
 *    - MEHMOOD-E-NISWAN GIRLS ELEMENTARY SCHOOL (LT.9E)
 *    - MOLANA MUHAMMAD HUSSAIN AZAD GIRLS SEC SCHOOL L.T 3S
 *    - Nawab Siddique Ali Khan English Medium School
 * 2. Academic Classes & Sections for each school.
 * 3. Exactly 60 Staff Members (15 HMs, 35 Teachers, 10 Non-Teaching Support Staff):
 *    - Full User accounts + Full TeacherProfile documents (CNIC, Employee ID, Qualification, Bank Details, Specializations, etc.)
 * 4. Exactly 24 Parent Accounts:
 *    - Full User accounts (Guardian / Parent details, phone numbers, child scope)
 * 5. Exactly 100 Students:
 *    - Full User accounts + Full StudentProfile documents (GR No, Admission Register No, Global Student ID, B-Form, DOB, Parents Linked, etc.)
 *
 * Idempotent: Can be run multiple times safely.
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { connectDatabase } from '../config/database.js';
import Organization from '../src/models/Organization.js';
import Town from '../src/models/Town.js';
import School from '../src/models/School.js';
import ClassModel from '../src/models/Class.js';
import Section from '../src/models/Section.js';
import User from '../src/models/User.js';
import TeacherProfile from '../src/models/TeacherProfile.js';
import StudentProfile from '../src/models/StudentProfile.js';
import {
  ROLES,
  BASE_ROLES,
  SCOPES,
  USER_STATUS,
  STUDENT_STATUS,
  TEACHER_STATUS,
} from '../config/constants.js';
import { hashPassword } from '../src/utils/passwordUtils.js';

export const SEED_DEFAULT_PASSWORD = 'Liaquatabad2026!';

// 15 Schools definition from the institutional image
const SCHOOLS_METADATA = [
  {
    name: 'Shibli Nomani English Medium School',
    schoolCode: 'SNEMS',
    emisCode: 'EMIS-40101-01',
    schoolType: 'ELEMENTARY',
    genderType: 'CO_EDUCATION',
    supportedMediums: ['ENGLISH', 'URDU'],
    address: 'Block 2, Near Commercial Market, Liaquatabad, Karachi',
    phone: '021-39910001',
    email: 'snems.liaquatabad@dmc.gov.pk',
    grades: [1, 2, 3, 4, 5, 6, 7, 8],
  },
  {
    name: 'Baba E Urdu Molvi Abdul Haq English Medium School',
    schoolCode: 'BUAHM',
    emisCode: 'EMIS-40101-02',
    schoolType: 'ELEMENTARY',
    genderType: 'CO_EDUCATION',
    supportedMediums: ['ENGLISH', 'URDU'],
    address: 'Block 1, Near Dak Khana, Liaquatabad, Karachi',
    phone: '021-39910002',
    email: 'buahm.liaquatabad@dmc.gov.pk',
    grades: [1, 2, 3, 4, 5, 6, 7, 8],
  },
  {
    name: 'Grand Citizen Girls Primary School LT 12-P',
    schoolCode: 'GCGPL',
    emisCode: 'EMIS-40101-03',
    schoolType: 'PRIMARY',
    genderType: 'GIRLS',
    supportedMediums: ['URDU', 'ENGLISH'],
    address: 'Plot 12-P, Block 3, Liaquatabad, Karachi',
    phone: '021-39910003',
    email: 'gcgpl.liaquatabad@dmc.gov.pk',
    grades: [1, 2, 3, 4, 5],
  },
  {
    name: 'Muslim Pilot Girls Primary School',
    schoolCode: 'MPGPS',
    emisCode: 'EMIS-40101-04',
    schoolType: 'PRIMARY',
    genderType: 'GIRLS',
    supportedMediums: ['URDU', 'ENGLISH'],
    address: 'Block 5, Near Eidgah Ground, Liaquatabad, Karachi',
    phone: '021-39910004',
    email: 'mpgps.liaquatabad@dmc.gov.pk',
    grades: [1, 2, 3, 4, 5],
  },
  {
    name: 'Huma Boys Primary School LT 19-P',
    schoolCode: 'HBPSL',
    emisCode: 'EMIS-40101-05',
    schoolType: 'PRIMARY',
    genderType: 'BOYS',
    supportedMediums: ['URDU', 'ENGLISH'],
    address: 'Plot 19-P, Block 4, Liaquatabad, Karachi',
    phone: '021-39910005',
    email: 'hbpsl.liaquatabad@dmc.gov.pk',
    grades: [1, 2, 3, 4, 5],
  },
  {
    name: 'Moulana Muhammad Husain Azad G/ P ENGLISH MEDIUM SCHOOL LT 17 (P)',
    schoolCode: 'MMH17',
    emisCode: 'EMIS-40101-06',
    schoolType: 'PRIMARY',
    genderType: 'GIRLS',
    supportedMediums: ['ENGLISH', 'URDU'],
    address: 'Plot 17-P, Block 6, Liaquatabad, Karachi',
    phone: '021-39910006',
    email: 'mmh17.liaquatabad@dmc.gov.pk',
    grades: [1, 2, 3, 4, 5],
  },
  {
    name: 'MOLANA MUHAMMAD HUSSAIN AZAD LT-18P',
    schoolCode: 'MMH18',
    emisCode: 'EMIS-40101-07',
    schoolType: 'PRIMARY',
    genderType: 'CO_EDUCATION',
    supportedMediums: ['URDU', 'ENGLISH'],
    address: 'Plot 18-P, Block 6, Liaquatabad, Karachi',
    phone: '021-39910007',
    email: 'mmh18.liaquatabad@dmc.gov.pk',
    grades: [1, 2, 3, 4, 5],
  },
  {
    name: 'MOULANA MUHAMMAD HUSSAIN AZAD BOYS SECONDARY SCHOOL (LT-4S)',
    schoolCode: 'MMH4S',
    emisCode: 'EMIS-40101-08',
    schoolType: 'SECONDARY',
    genderType: 'BOYS',
    supportedMediums: ['URDU', 'ENGLISH'],
    address: 'Plot 4-S, Block 6, Liaquatabad, Karachi',
    phone: '021-39910008',
    email: 'mmh4s.liaquatabad@dmc.gov.pk',
    grades: [6, 7, 8, 9, 10],
  },
  {
    name: 'MOLANA FAZAL UL HAQ ELEMENTARY SCHOOL',
    schoolCode: 'MFHES',
    emisCode: 'EMIS-40101-09',
    schoolType: 'ELEMENTARY',
    genderType: 'CO_EDUCATION',
    supportedMediums: ['URDU', 'ENGLISH'],
    address: 'Block 7, Liaquatabad, Karachi',
    phone: '021-39910009',
    email: 'mfhes.liaquatabad@dmc.gov.pk',
    grades: [1, 2, 3, 4, 5, 6, 7, 8],
  },
  {
    name: 'BEGUM RANA LIAQUAT ALI KHAN ENGLISH MEDIUM SCHOOL',
    schoolCode: 'BRLAE',
    emisCode: 'EMIS-40101-10',
    schoolType: 'ELEMENTARY',
    genderType: 'CO_EDUCATION',
    supportedMediums: ['ENGLISH', 'URDU'],
    address: 'Block 8, Near Post Office, Liaquatabad, Karachi',
    phone: '021-39910010',
    email: 'brlae.liaquatabad@dmc.gov.pk',
    grades: [1, 2, 3, 4, 5, 6, 7, 8],
  },
  {
    name: 'BEGUM RA\'ANA LIAQUAT ALI KHAN GIRLS SECONDARY SCHOOL',
    schoolCode: 'BRLAG',
    emisCode: 'EMIS-40101-11',
    schoolType: 'SECONDARY',
    genderType: 'GIRLS',
    supportedMediums: ['URDU', 'ENGLISH'],
    address: 'Block 8, Liaquatabad, Karachi',
    phone: '021-39910011',
    email: 'brlag.liaquatabad@dmc.gov.pk',
    grades: [6, 7, 8, 9, 10],
  },
  {
    name: 'Grammar Girls Primary School LT-16 P',
    schoolCode: 'GGPSL',
    emisCode: 'EMIS-40101-12',
    schoolType: 'PRIMARY',
    genderType: 'GIRLS',
    supportedMediums: ['URDU', 'ENGLISH'],
    address: 'Plot 16-P, Block 9, Liaquatabad, Karachi',
    phone: '021-39910012',
    email: 'ggpsl.liaquatabad@dmc.gov.pk',
    grades: [1, 2, 3, 4, 5],
  },
  {
    name: 'MEHMOOD-E-NISWAN GIRLS ELEMENTARY SCHOOL (LT.9E)',
    schoolCode: 'MNGES',
    emisCode: 'EMIS-40101-13',
    schoolType: 'ELEMENTARY',
    genderType: 'GIRLS',
    supportedMediums: ['URDU', 'ENGLISH'],
    address: 'Plot 9-E, Block 9, Liaquatabad, Karachi',
    phone: '021-39910013',
    email: 'mnges.liaquatabad@dmc.gov.pk',
    grades: [1, 2, 3, 4, 5, 6, 7, 8],
  },
  {
    name: 'MOLANA MUHAMMAD HUSSAIN AZAD GIRLS SEC SCHOOL L.T 3S',
    schoolCode: 'MMH3S',
    emisCode: 'EMIS-40101-14',
    schoolType: 'SECONDARY',
    genderType: 'GIRLS',
    supportedMediums: ['URDU', 'ENGLISH'],
    address: 'Plot 3-S, Block 6, Liaquatabad, Karachi',
    phone: '021-39910014',
    email: 'mmh3s.liaquatabad@dmc.gov.pk',
    grades: [6, 7, 8, 9, 10],
  },
  {
    name: 'Nawab Siddique Ali Khan English Medium School',
    schoolCode: 'NSAKE',
    emisCode: 'EMIS-40101-15',
    schoolType: 'SECONDARY',
    genderType: 'CO_EDUCATION',
    supportedMediums: ['ENGLISH', 'URDU'],
    address: 'Block 10, Near Al-Karam Square, Liaquatabad, Karachi',
    phone: '021-39910015',
    email: 'nsake.liaquatabad@dmc.gov.pk',
    grades: [6, 7, 8, 9, 10],
  },
];

// 60 Staff Members (15 HMs, 35 Teachers, 10 Non-teaching Staff)
const STAFF_DATA = [
  // --- 15 Head Masters (1 per school) ---
  {
    fullName: 'Syed Manzoor Hussain Shah',
    fatherName: 'Syed Ghulam Hussain Shah',
    gender: 'MALE',
    role: ROLES.HM,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Head Master (BPS-17)',
    qualification: 'M.Ed, M.Sc Physics',
    specialization: ['Physics', 'Educational Administration'],
    schoolIndex: 0, // Shibli Nomani
    isTeachingStaff: true,
  },
  {
    fullName: 'Mohammad Tariq Qureshi',
    fatherName: 'Abdul Ghafoor Qureshi',
    gender: 'MALE',
    role: ROLES.HM,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Head Master (BPS-17)',
    qualification: 'M.Ed, M.A Urdu Literature',
    specialization: ['Urdu', 'School Leadership'],
    schoolIndex: 1, // Baba E Urdu
    isTeachingStaff: true,
  },
  {
    fullName: 'Farhana Parveen Naz',
    fatherName: 'Sheikh Muhammad Nazir',
    gender: 'FEMALE',
    role: ROLES.HM,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Head Mistress (BPS-17)',
    qualification: 'M.Ed, M.A English',
    specialization: ['English', 'Early Childhood Pedagogy'],
    schoolIndex: 2, // Grand Citizen Girls
    isTeachingStaff: true,
  },
  {
    fullName: 'Shaheen Akhtar Begum',
    fatherName: 'Muhammad Akhtar Siddiqui',
    gender: 'FEMALE',
    role: ROLES.HM,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Head Mistress (BPS-17)',
    qualification: 'M.Ed, M.Sc Mathematics',
    specialization: ['Mathematics', 'Primary Education'],
    schoolIndex: 3, // Muslim Pilot Girls
    isTeachingStaff: true,
  },
  {
    fullName: 'Abdul Rasheed Khan',
    fatherName: 'Muhammad Ismail Khan',
    gender: 'MALE',
    role: ROLES.HM,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Head Master (BPS-17)',
    qualification: 'M.Ed, M.Sc Chemistry',
    specialization: ['General Science', 'Educational Planning'],
    schoolIndex: 4, // Huma Boys
    isTeachingStaff: true,
  },
  {
    fullName: 'Nuzhat Ara Siddiqui',
    fatherName: 'Mirza Mehboob Baig',
    gender: 'FEMALE',
    role: ROLES.HM,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Head Mistress (BPS-17)',
    qualification: 'M.Ed, M.A Islamic Studies',
    specialization: ['English', 'Islamiat'],
    schoolIndex: 5, // Moulana Azad G/P English
    isTeachingStaff: true,
  },
  {
    fullName: 'Zahid Mehmood Abbasi',
    fatherName: 'Mehmood Ul Hassan',
    gender: 'MALE',
    role: ROLES.HM,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Head Master (BPS-17)',
    qualification: 'M.Ed, M.Sc Zoology',
    specialization: ['Biology', 'Elementary Science'],
    schoolIndex: 6, // Molana Azad LT-18P
    isTeachingStaff: true,
  },
  {
    fullName: 'Muhammad Asif Mughal',
    fatherName: 'Muhammad Sharif Mughal',
    gender: 'MALE',
    role: ROLES.HM,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Head Master (BPS-17)',
    qualification: 'M.Ed, M.Sc Mathematics',
    specialization: ['Mathematics', 'Physics'],
    schoolIndex: 7, // Moulana Azad Boys Secondary
    isTeachingStaff: true,
  },
  {
    fullName: 'Kamran Hafeez Alvi',
    fatherName: 'Hafeez Ullah Alvi',
    gender: 'MALE',
    role: ROLES.HM,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Head Master (BPS-17)',
    qualification: 'M.Ed, M.A History',
    specialization: ['Social Studies', 'Pakistan Studies'],
    schoolIndex: 8, // Molana Fazal Ul Haq
    isTeachingStaff: true,
  },
  {
    fullName: 'Rubina Yasmeen',
    fatherName: 'Syed Anwar Ali',
    gender: 'FEMALE',
    role: ROLES.HM,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Head Mistress (BPS-17)',
    qualification: 'M.Ed, M.A English Literature',
    specialization: ['English', 'Grammar Pedagogy'],
    schoolIndex: 9, // Begum Rana English
    isTeachingStaff: true,
  },
  {
    fullName: 'Tahira Jabeen Qazi',
    fatherName: 'Qazi Abdul Waheed',
    gender: 'FEMALE',
    role: ROLES.HM,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Head Mistress (BPS-17)',
    qualification: 'M.Ed, M.Sc Botany',
    specialization: ['Biology', 'Secondary Science'],
    schoolIndex: 10, // Begum Raana Girls Secondary
    isTeachingStaff: true,
  },
  {
    fullName: 'Ghazala Bano',
    fatherName: 'Nawab Khan Niazi',
    gender: 'FEMALE',
    role: ROLES.HM,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Head Mistress (BPS-17)',
    qualification: 'M.Ed, M.A Political Science',
    specialization: ['Urdu', 'Social Studies'],
    schoolIndex: 11, // Grammar Girls Primary
    isTeachingStaff: true,
  },
  {
    fullName: 'Nasira Khatoon',
    fatherName: 'Sheikh Muhammad Iqbal',
    gender: 'FEMALE',
    role: ROLES.HM,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Head Mistress (BPS-17)',
    qualification: 'M.Ed, M.A Economics',
    specialization: ['Mathematics', 'General Science'],
    schoolIndex: 12, // Mehmood-e-Niswan
    isTeachingStaff: true,
  },
  {
    fullName: 'Fouzia Sultana',
    fatherName: 'Syed Masood Ahmed',
    gender: 'FEMALE',
    role: ROLES.HM,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Head Mistress (BPS-17)',
    qualification: 'M.Ed, M.Sc Chemistry',
    specialization: ['Chemistry', 'Secondary Education'],
    schoolIndex: 13, // Molana Azad Girls Sec
    isTeachingStaff: true,
  },
  {
    fullName: 'Dr. Shakeel Ahmed Farooqi',
    fatherName: 'Ahmed Saeed Farooqi',
    gender: 'MALE',
    role: ROLES.HM,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Head Master (BPS-17)',
    qualification: 'Ph.D Education, M.Sc Physics',
    specialization: ['Physics', 'Computer Science'],
    schoolIndex: 14, // Nawab Siddique Ali Khan
    isTeachingStaff: true,
  },

  // --- 35 Teaching Staff ---
  {
    fullName: 'Muhammad Bilal Rajput',
    fatherName: 'Muhammad Yousuf Rajput',
    gender: 'MALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Senior Teacher (BPS-16)',
    qualification: 'M.Sc Mathematics, B.Ed',
    specialization: ['Mathematics', 'Statistics'],
    schoolIndex: 0,
    isTeachingStaff: true,
  },
  {
    fullName: 'Syeda Anam Fatima',
    fatherName: 'Syed Nayyar Hussain',
    gender: 'FEMALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Junior School Teacher (BPS-14)',
    qualification: 'B.Sc Physics, B.Ed',
    specialization: ['General Science', 'Physics'],
    schoolIndex: 0,
    isTeachingStaff: true,
  },
  {
    fullName: 'Abdul Qadir Memon',
    fatherName: 'Ghulam Qadir Memon',
    gender: 'MALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Secondary School Teacher (BPS-16)',
    qualification: 'M.A English, B.Ed',
    specialization: ['English', 'Literature'],
    schoolIndex: 1,
    isTeachingStaff: true,
  },
  {
    fullName: 'Afsheen Zehra',
    fatherName: 'Syed Ali Raza Zaidi',
    gender: 'FEMALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Primary School Teacher (BPS-12)',
    qualification: 'B.A General, B.Ed',
    specialization: ['Urdu', 'Islamiat'],
    schoolIndex: 1,
    isTeachingStaff: true,
  },
  {
    fullName: 'Khadija Tul Kubra',
    fatherName: 'Muhammad Yaqoob',
    gender: 'FEMALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Senior Teacher (BPS-16)',
    qualification: 'M.Sc Botany, B.Ed',
    specialization: ['General Science', 'Biology'],
    schoolIndex: 2,
    isTeachingStaff: true,
  },
  {
    fullName: 'Samreen Tariq',
    fatherName: 'Tariq Mehmood Siddiqui',
    gender: 'FEMALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Primary School Teacher (BPS-12)',
    qualification: 'B.Sc Home Economics',
    specialization: ['Arts', 'Social Studies'],
    schoolIndex: 2,
    isTeachingStaff: true,
  },
  {
    fullName: 'Mehwish Riaz',
    fatherName: 'Riaz Ahmed Baig',
    gender: 'FEMALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Junior School Teacher (BPS-14)',
    qualification: 'M.A Urdu, B.Ed',
    specialization: ['Urdu', 'Islamiat'],
    schoolIndex: 3,
    isTeachingStaff: true,
  },
  {
    fullName: 'Shazia Kausar',
    fatherName: 'Kausar Ali Khan',
    gender: 'FEMALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Primary School Teacher (BPS-12)',
    qualification: 'B.A Islamic Studies, B.Ed',
    specialization: ['Islamiat', 'Quranic Studies'],
    schoolIndex: 3,
    isTeachingStaff: true,
  },
  {
    fullName: 'Waqas Ahmed Sheikh',
    fatherName: 'Sheikh Jalal Uddin',
    gender: 'MALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Secondary School Teacher (BPS-16)',
    qualification: 'M.Sc Chemistry, B.Ed',
    specialization: ['Chemistry', 'General Science'],
    schoolIndex: 4,
    isTeachingStaff: true,
  },
  {
    fullName: 'Usman Ghani Ansari',
    fatherName: 'Ansari Abdul Sattar',
    gender: 'MALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Primary School Teacher (BPS-12)',
    qualification: 'B.Sc Mathematics',
    specialization: ['Mathematics'],
    schoolIndex: 4,
    isTeachingStaff: true,
  },
  {
    fullName: 'Hina Danish',
    fatherName: 'Danish Ali Mirza',
    gender: 'FEMALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Junior School Teacher (BPS-14)',
    qualification: 'M.A English Literature',
    specialization: ['English', 'Spoken English'],
    schoolIndex: 5,
    isTeachingStaff: true,
  },
  {
    fullName: 'Sadia Noreen',
    fatherName: 'Noreen Ul Haq',
    gender: 'FEMALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Primary School Teacher (BPS-12)',
    qualification: 'B.A General, B.Ed',
    specialization: ['Urdu', 'Sindhi'],
    schoolIndex: 5,
    isTeachingStaff: true,
  },
  {
    fullName: 'Irfan Ullah Wasti',
    fatherName: 'Fazal Ullah Wasti',
    gender: 'MALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Senior Teacher (BPS-16)',
    qualification: 'M.Sc Physics, B.Ed',
    specialization: ['Physics', 'Mathematics'],
    schoolIndex: 6,
    isTeachingStaff: true,
  },
  {
    fullName: 'Farrukh Shahzad',
    fatherName: 'Shahzad Ahmed',
    gender: 'MALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Primary School Teacher (BPS-12)',
    qualification: 'B.Sc Zoology',
    specialization: ['General Science'],
    schoolIndex: 6,
    isTeachingStaff: true,
  },
  {
    fullName: 'Naveed Akhtar Malik',
    fatherName: 'Malik Ghulam Rasool',
    gender: 'MALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Secondary School Teacher (BPS-16)',
    qualification: 'M.Sc Computer Science, B.Ed',
    specialization: ['Computer Science', 'Mathematics'],
    schoolIndex: 7,
    isTeachingStaff: true,
  },
  {
    fullName: 'Tanveer Ahmed Abbasi',
    fatherName: 'Abbasi Muhammad Sadiq',
    gender: 'MALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Secondary School Teacher (BPS-16)',
    qualification: 'M.A Pakistan Studies, B.Ed',
    specialization: ['Pakistan Studies', 'Social Studies'],
    schoolIndex: 7,
    isTeachingStaff: true,
  },
  {
    fullName: 'Rizwan Haider Zaidi',
    fatherName: 'Syed Ali Haider Zaidi',
    gender: 'MALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Junior School Teacher (BPS-14)',
    qualification: 'B.Sc Physics, B.Ed',
    specialization: ['General Science', 'Physics'],
    schoolIndex: 8,
    isTeachingStaff: true,
  },
  {
    fullName: 'Sajid Mehmood Lodhi',
    fatherName: 'Lodhi Abdul Majeed',
    gender: 'MALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Primary School Teacher (BPS-12)',
    qualification: 'B.A General, B.Ed',
    specialization: ['Urdu', 'Islamiat'],
    schoolIndex: 8,
    isTeachingStaff: true,
  },
  {
    fullName: 'Adeel ur Rehman',
    fatherName: 'Habib ur Rehman',
    gender: 'MALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Senior Teacher (BPS-16)',
    qualification: 'M.A English, M.Ed',
    specialization: ['English', 'Grammar'],
    schoolIndex: 9,
    isTeachingStaff: true,
  },
  {
    fullName: 'Saima Binte Aslam',
    fatherName: 'Muhammad Aslam Khan',
    gender: 'FEMALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Junior School Teacher (BPS-14)',
    qualification: 'M.Sc Mathematics',
    specialization: ['Mathematics'],
    schoolIndex: 9,
    isTeachingStaff: true,
  },
  {
    fullName: 'Najma Shaheen',
    fatherName: 'Shaheen Akhtar Khan',
    gender: 'FEMALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Secondary School Teacher (BPS-16)',
    qualification: 'M.Sc Biology, B.Ed',
    specialization: ['Biology', 'Chemistry'],
    schoolIndex: 10,
    isTeachingStaff: true,
  },
  {
    fullName: 'Munazza Hashmi',
    fatherName: 'Syed Hashim Ali',
    gender: 'FEMALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Secondary School Teacher (BPS-16)',
    qualification: 'M.A Urdu Literature, B.Ed',
    specialization: ['Urdu', 'Literature'],
    schoolIndex: 10,
    isTeachingStaff: true,
  },
  {
    fullName: 'Asma Parveen Niazi',
    fatherName: 'Niazi Abdul Sattar',
    gender: 'FEMALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Primary School Teacher (BPS-12)',
    qualification: 'B.A Education, B.Ed',
    specialization: ['Primary Pedagogy', 'Social Studies'],
    schoolIndex: 11,
    isTeachingStaff: true,
  },
  {
    fullName: 'Madiha Kanwal',
    fatherName: 'Kanwal Saeed',
    gender: 'FEMALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Primary School Teacher (BPS-12)',
    qualification: 'B.Sc Mathematics',
    specialization: ['Mathematics', 'General Science'],
    schoolIndex: 11,
    isTeachingStaff: true,
  },
  {
    fullName: 'Salma Tabassum',
    fatherName: 'Tabassum Hussain',
    gender: 'FEMALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Junior School Teacher (BPS-14)',
    qualification: 'M.A Islamiat, B.Ed',
    specialization: ['Islamiat', 'Arabic'],
    schoolIndex: 12,
    isTeachingStaff: true,
  },
  {
    fullName: 'Farzana Nigar',
    fatherName: 'Nigar Ahmed Khan',
    gender: 'FEMALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Junior School Teacher (BPS-14)',
    qualification: 'B.Sc Zoology, B.Ed',
    specialization: ['General Science'],
    schoolIndex: 12,
    isTeachingStaff: true,
  },
  {
    fullName: 'Rehana Kausar',
    fatherName: 'Kausar Mehmood',
    gender: 'FEMALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Secondary School Teacher (BPS-16)',
    qualification: 'M.Sc Physics, B.Ed',
    specialization: ['Physics', 'Mathematics'],
    schoolIndex: 13,
    isTeachingStaff: true,
  },
  {
    fullName: 'Anila Batool',
    fatherName: 'Batool Hussain Naqvi',
    gender: 'FEMALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Secondary School Teacher (BPS-16)',
    qualification: 'M.A English, B.Ed',
    specialization: ['English', 'Literature'],
    schoolIndex: 13,
    isTeachingStaff: true,
  },
  {
    fullName: 'Kashif Jamil Siddiqui',
    fatherName: 'Jamil Ahmed Siddiqui',
    gender: 'MALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Secondary School Teacher (BPS-16)',
    qualification: 'M.Sc Computer Science, B.Ed',
    specialization: ['Computer Science', 'Physics'],
    schoolIndex: 14,
    isTeachingStaff: true,
  },
  {
    fullName: 'Naveed Iqbal Chaudhry',
    fatherName: 'Iqbal Hussain Chaudhry',
    gender: 'MALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Senior Teacher (BPS-16)',
    qualification: 'M.Sc Chemistry, M.Ed',
    specialization: ['Chemistry', 'General Science'],
    schoolIndex: 14,
    isTeachingStaff: true,
  },
  {
    fullName: 'Muhammad Zubair Ansari',
    fatherName: 'Ansari Noor Muhammad',
    gender: 'MALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Junior School Teacher (BPS-14)',
    qualification: 'B.Sc Mathematics, B.Ed',
    specialization: ['Mathematics'],
    schoolIndex: 0,
    isTeachingStaff: true,
  },
  {
    fullName: 'Nasir Abbas Kazmi',
    fatherName: 'Kazmi Ghulam Abbas',
    gender: 'MALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Secondary School Teacher (BPS-16)',
    qualification: 'M.A History, B.Ed',
    specialization: ['Pakistan Studies', 'Sindhi'],
    schoolIndex: 7,
    isTeachingStaff: true,
  },
  {
    fullName: 'Sumaira Anjum',
    fatherName: 'Anjum Pervez',
    gender: 'FEMALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Primary School Teacher (BPS-12)',
    qualification: 'B.A General, B.Ed',
    specialization: ['Urdu', 'Drawing'],
    schoolIndex: 3,
    isTeachingStaff: true,
  },
  {
    fullName: 'Fariha Yasmeen',
    fatherName: 'Muhammad Yasmeen Khan',
    gender: 'FEMALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Junior School Teacher (BPS-14)',
    qualification: 'B.Sc General Science, B.Ed',
    specialization: ['General Science', 'Mathematics'],
    schoolIndex: 10,
    isTeachingStaff: true,
  },
  {
    fullName: 'Junaid Ahmed Qureshi',
    fatherName: 'Qureshi Bashir Ahmed',
    gender: 'MALE',
    role: ROLES.TEACHER,
    baseRole: BASE_ROLES.TEACHER,
    designation: 'Secondary School Teacher (BPS-16)',
    qualification: 'M.A English Literature, B.Ed',
    specialization: ['English'],
    schoolIndex: 14,
    isTeachingStaff: true,
  },

  // --- 10 Non-Teaching Support Staff ---
  {
    fullName: 'Ghulam Rasool Brohi',
    fatherName: 'Brohi Ali Bux',
    gender: 'MALE',
    role: ROLES.PEON,
    baseRole: BASE_ROLES.PEON,
    designation: 'Senior Clerk (BPS-14)',
    qualification: 'Intermediate (Commerce)',
    specialization: [],
    schoolIndex: 0,
    isTeachingStaff: false,
  },
  {
    fullName: 'Muhammad Hanif Soomro',
    fatherName: 'Soomro Abdul Kareem',
    gender: 'MALE',
    role: ROLES.PEON,
    baseRole: BASE_ROLES.PEON,
    designation: 'Junior Clerk (BPS-11)',
    qualification: 'Intermediate (Arts)',
    specialization: [],
    schoolIndex: 1,
    isTeachingStaff: false,
  },
  {
    fullName: 'Babu Ram Das',
    fatherName: 'Das Chagan Lal',
    gender: 'MALE',
    role: ROLES.PEON,
    baseRole: BASE_ROLES.PEON,
    designation: 'Naib Qasid (BPS-02)',
    qualification: 'Matriculation',
    specialization: [],
    schoolIndex: 2,
    isTeachingStaff: false,
  },
  {
    fullName: 'Allah Ditta Khokhar',
    fatherName: 'Khokhar Roshan Din',
    gender: 'MALE',
    role: ROLES.PEON,
    baseRole: BASE_ROLES.PEON,
    designation: 'Naib Qasid (BPS-02)',
    qualification: 'Middle Pass',
    specialization: [],
    schoolIndex: 4,
    isTeachingStaff: false,
  },
  {
    fullName: 'Muhammad Rafiq Shah',
    fatherName: 'Shah Nawaz Shah',
    gender: 'MALE',
    role: ROLES.PEON,
    baseRole: BASE_ROLES.PEON,
    designation: 'Senior Clerk (BPS-14)',
    qualification: 'B.Com',
    specialization: [],
    schoolIndex: 7,
    isTeachingStaff: false,
  },
  {
    fullName: 'Abdul Shakoor Baloch',
    fatherName: 'Baloch Dad Karim',
    gender: 'MALE',
    role: ROLES.PEON,
    baseRole: BASE_ROLES.PEON,
    designation: 'Lab Attendant (BPS-05)',
    qualification: 'Matric (Science)',
    specialization: [],
    schoolIndex: 8,
    isTeachingStaff: false,
  },
  {
    fullName: 'Zainab Bibi',
    fatherName: 'Muhammad Din',
    gender: 'FEMALE',
    role: ROLES.PEON,
    baseRole: BASE_ROLES.PEON,
    designation: 'Aya / Support Staff (BPS-02)',
    qualification: 'Primary Pass',
    specialization: [],
    schoolIndex: 10,
    isTeachingStaff: false,
  },
  {
    fullName: 'Sultan Mehmood Bhatti',
    fatherName: 'Bhatti Nazir Ahmed',
    gender: 'MALE',
    role: ROLES.PEON,
    baseRole: BASE_ROLES.PEON,
    designation: 'Daftari (BPS-03)',
    qualification: 'Matriculation',
    specialization: [],
    schoolIndex: 12,
    isTeachingStaff: false,
  },
  {
    fullName: 'Rashid Minhas Gondal',
    fatherName: 'Gondal Muhammad Arif',
    gender: 'MALE',
    role: ROLES.PEON,
    baseRole: BASE_ROLES.PEON,
    designation: 'Junior Clerk (BPS-11)',
    qualification: 'Intermediate',
    specialization: [],
    schoolIndex: 13,
    isTeachingStaff: false,
  },
  {
    fullName: 'Mukhtar Ahmed Chandio',
    fatherName: 'Chandio Darya Khan',
    gender: 'MALE',
    role: ROLES.PEON,
    baseRole: BASE_ROLES.PEON,
    designation: 'Senior Clerk (BPS-14)',
    qualification: 'B.A General',
    specialization: [],
    schoolIndex: 14,
    isTeachingStaff: false,
  },
];

// 24 Parent Accounts
const PARENTS_DATA = [
  { fullName: 'Muhammad Tariq Mehmood', gender: 'MALE', relation: 'FATHER' },
  { fullName: 'Syed Zulfiqar Ali Zaidi', gender: 'MALE', relation: 'FATHER' },
  { fullName: 'Abdul Jabbar Sheikh', gender: 'MALE', relation: 'FATHER' },
  { fullName: 'Dr. Shakeel Ahmed Malik', gender: 'MALE', relation: 'FATHER' },
  { fullName: 'Muhammad Farooq Qureshi', gender: 'MALE', relation: 'FATHER' },
  { fullName: 'Naveed Akhtar Siddiqui', gender: 'MALE', relation: 'FATHER' },
  { fullName: 'Parveen Begum', gender: 'FEMALE', relation: 'MOTHER' },
  { fullName: 'Khurram Shehzad Lodhi', gender: 'MALE', relation: 'FATHER' },
  { fullName: 'Mirza Kamran Baig', gender: 'MALE', relation: 'FATHER' },
  { fullName: 'Haji Abdul Sattar Memon', gender: 'MALE', relation: 'FATHER' },
  { fullName: 'Riaz Ul Hassan Abbasi', gender: 'MALE', relation: 'FATHER' },
  { fullName: 'Shafiq Ur Rehman Khan', gender: 'MALE', relation: 'FATHER' },
  { fullName: 'Nasreen Akhtar', gender: 'FEMALE', relation: 'MOTHER' },
  { fullName: 'Muhammad Imran Yousuf', gender: 'MALE', relation: 'FATHER' },
  { fullName: 'Tahir Hussain Shah', gender: 'MALE', relation: 'FATHER' },
  { fullName: 'Muhammad Nadeem Ansari', gender: 'MALE', relation: 'FATHER' },
  { fullName: 'Ghulam Mustafa Chandio', gender: 'MALE', relation: 'FATHER' },
  { fullName: 'Mst. Shazia Sultana', gender: 'FEMALE', relation: 'MOTHER' },
  { fullName: 'Asif Iqbal Rajput', gender: 'MALE', relation: 'FATHER' },
  { fullName: 'Waseem Akram Bhatti', gender: 'MALE', relation: 'FATHER' },
  { fullName: 'Javed Akhtar Awan', gender: 'MALE', relation: 'FATHER' },
  { fullName: 'Muhammad Salman Farooqi', gender: 'MALE', relation: 'FATHER' },
  { fullName: 'Dr. Munir Ahmed Baloch', gender: 'MALE', relation: 'FATHER' },
  { fullName: 'Zafar Iqbal Mughal', gender: 'MALE', relation: 'FATHER' },
];

// First names pool for authentic Pakistani students
const BOY_FIRST_NAMES = [
  'Muhammad Hamza', 'Bilal Ahmed', 'Usman Raza', 'Ali Hassan', 'Zain Ul Abideen',
  'Talha Zubair', 'Saad Farooq', 'Umer Farooq', 'Abdullah Tariq', 'Danish Ali',
  'Huzaifa Kamran', 'Hassan Raza', 'Mustafa Jabbar', 'Fahad Mehmood', 'Hamid Raza',
  'Waleed Asif', 'Rayan Sheikh', 'Subhan Malik', 'Haris Nadeem', 'Moiz Akhtar',
  'Shahzaib Khan', 'Zeeshan Haider', 'Ahsan Iqbal', 'Rohail Abbas', 'Sufiyan Ahmed',
  'Ammar Yasir', 'Ovais Qarni', 'Mubeen Ur Rehman', 'Affan Siddiqui', 'Shoaib Akhtar',
];

const GIRL_FIRST_NAMES = [
  'Ayesha Fatima', 'Zainab Bibi', 'Fatima Zahra', 'Maryam Noor', 'Hafsa Tariq',
  'Khadija Tul Kubra', 'Areeba Shakeel', 'Laiba Farooq', 'Mahnoor Zulfiqar', 'Anum Siddiqui',
  'Hoorain Malik', 'Sidra Tul Muntaha', 'Dua Fatima', 'Eshal Naveed', 'Alishba Khan',
  'Hira Parveen', 'Bushra Bibi', 'Iqra Jabeen', 'Sana Mir', 'Momina Lodhi',
  'Bismah Maroof', 'Nida Dar', 'Manahil Fatima', 'Rida Zehra', 'Umaima Qureshi',
  'Sawera Baig', 'Kinza Hashmi', 'Tooba Rehman', 'Farwa Kazmi', 'Amna Ansari',
];

export async function runLiaquatabadSeed() {
  console.log('\n==============================================================================');
  console.log('🏛️ SEEDING LIAQUATABAD TOWN CENTRE (DMC) COMPREHENSIVE DATASET');
  console.log('==============================================================================\n');

  await connectDatabase();

  const commonPasswordHash = await hashPassword(SEED_DEFAULT_PASSWORD);

  // 1. Organization and Town
  console.log('🔹 [1/5] Linking Municipal Organization & Town Jurisdiction...');
  let org = await Organization.findOne({ code: 'DMC_LIAQUATABAD' });
  if (!org) {
    org = await Organization.findOne({ code: 'DMC-LQT' });
  }
  if (!org) {
    org = await Organization.create({
      name: 'Education Department (DMC)',
      code: 'DMC_LIAQUATABAD',
      status: 'ACTIVE',
    });
  }

  let town = await Town.findOne({ organizationId: org._id });
  if (!town) {
    town = await Town.create({
      organizationId: org._id,
      name: 'Liaquatabad Town Centre',
      code: 'TOWN_LIAQ',
      officeAddress: 'Liaquatabad Town Centre Municipal Complex, Karachi',
      status: 'ACTIVE',
    });
  }

  console.log(`   Organization: ${org.name} (${org.code})`);
  console.log(`   Town: ${town.name} (${town.code})`);

  // 2. Seed Exactly 15 Schools
  console.log('\n🔹 [2/5] Seeding 15 Schools from Official Register...');
  const seededSchools = [];
  const schoolClassesMap = new Map(); // schoolId -> array of classes with sections

  for (const meta of SCHOOLS_METADATA) {
    const schoolDoc = await School.findOneAndUpdate(
      { schoolCode: meta.schoolCode },
      {
        $set: {
          organizationId: org._id,
          townId: town._id,
          name: meta.name,
          schoolCode: meta.schoolCode,
          emisCode: meta.emisCode,
          schoolType: meta.schoolType,
          genderType: meta.genderType,
          supportedMediums: meta.supportedMediums,
          address: meta.address,
          contactPhone: meta.phone,
          contactEmail: meta.email,
          status: 'ACTIVE',
        },
      },
      { upsert: true, new: true }
    );
    seededSchools.push(schoolDoc);

    // Setup Classes and Sections for this school
    const classList = [];
    for (const gradeNum of meta.grades) {
      const cls = await ClassModel.findOneAndUpdate(
        { schoolId: schoolDoc._id, numericGrade: gradeNum },
        {
          $set: {
            name: `Class ${gradeNum}`,
            code: `CLS-${gradeNum}`,
            numericGrade: gradeNum,
            status: 'ACTIVE',
          },
        },
        { upsert: true, new: true }
      );

      const secA = await Section.findOneAndUpdate(
        { classId: cls._id, schoolId: schoolDoc._id, name: 'A' },
        {
          $set: {
            medium: meta.supportedMediums.includes('ENGLISH') ? 'ENGLISH' : 'URDU',
            capacity: 45,
            roomNumber: `R-${gradeNum}01`,
            status: 'ACTIVE',
          },
        },
        { upsert: true, new: true }
      );

      const secB = await Section.findOneAndUpdate(
        { classId: cls._id, schoolId: schoolDoc._id, name: 'B' },
        {
          $set: {
            medium: 'URDU',
            capacity: 45,
            roomNumber: `R-${gradeNum}02`,
            status: 'ACTIVE',
          },
        },
        { upsert: true, new: true }
      );

      classList.push({ classDoc: cls, sections: [secA, secB] });
    }
    schoolClassesMap.set(schoolDoc._id.toString(), classList);
    console.log(`   ✅ [School ${seededSchools.length}/15] ${schoolDoc.name} (${schoolDoc.schoolCode}) — ${classList.length} Classes`);
  }

  // 3. Seed Exactly 60 Staff Members (15 HMs, 35 Teachers, 10 Non-Teaching)
  console.log('\n🔹 [3/5] Seeding 60 Staff Members (15 HMs, 35 Teachers, 10 Support Staff)...');
  const seededStaffUsers = [];

  for (let i = 0; i < STAFF_DATA.length; i++) {
    const s = STAFF_DATA[i];
    const targetSchool = seededSchools[s.schoolIndex];
    const emailNum = String(i + 1).padStart(2, '0');
    const email = `staff${emailNum}.liaquatabad@dmc.gov.pk`;
    const employeeId = `EMP-LQT-${1001 + i}`;
    const cnic = `42101-${String(1000000 + i * 1111).slice(0, 7)}-${(i % 9) + 1}`;
    const phone = `0300-${String(1110000 + i + 1).padStart(7, '0')}`;

    let scope = SCOPES.CLASS_SECTION;
    if (s.role === ROLES.HM) scope = SCOPES.SCHOOL;
    if (s.role === ROLES.PEON) scope = SCOPES.SELF;

    const userDoc = await User.findOneAndUpdate(
      { email },
      {
        $set: {
          organizationId: org._id,
          townId: town._id,
          schoolId: targetSchool._id,
          fullName: s.fullName,
          email,
          passwordHash: commonPasswordHash,
          phoneNumber: phone,
          designation: s.designation,
          baseRole: s.baseRole,
          role: s.role,
          scope,
          status: USER_STATUS.ACTIVE,
          tokenVersion: 0,
        },
      },
      { upsert: true, new: true }
    );

    await TeacherProfile.findOneAndUpdate(
      { userId: userDoc._id },
      {
        $set: {
          currentSchoolId: targetSchool._id,
          fatherName: s.fatherName,
          dateOfBirth: new Date(1975 + (i % 22), (i % 12), 10),
          cnic,
          employeeId,
          designation: s.designation,
          appointmentDate: new Date(2014 + (i % 8), 7, 15),
          joiningDate: new Date(2018 + (i % 6), 8, 1),
          qualification: s.qualification,
          isTeachingStaff: s.isTeachingStaff,
          specializationSubjects: s.specialization,
          bankName: i % 2 === 0 ? 'National Bank of Pakistan' : 'Sindh Bank',
          branchName: 'Liaquatabad Branch (0128), Karachi',
          accountNumber: `012800${String(10000000 + i * 23)}`,
          accountTitle: s.fullName,
          lifecycleStatus: TEACHER_STATUS.ACTIVE,
        },
      },
      { upsert: true, new: true }
    );

    // If staff is HM, set as institutional reference if appropriate
    if (s.role === ROLES.HM) {
      await School.findByIdAndUpdate(targetSchool._id, {
        $set: { schoolCodeSetBy: userDoc._id, schoolCodeSetAt: new Date() },
      });
    }

    seededStaffUsers.push(userDoc);
  }
  console.log(`   ✅ Seeded Exactly ${seededStaffUsers.length} Staff Accounts with Full Profiles.`);

  // 4. Seed Exactly 24 Parent Accounts
  console.log('\n🔹 [4/5] Seeding 24 Parent Accounts...');
  const seededParents = [];

  for (let i = 0; i < PARENTS_DATA.length; i++) {
    const p = PARENTS_DATA[i];
    const parentNum = String(i + 1).padStart(2, '0');
    const email = `parent${parentNum}.liaquatabad@dmc.gov.pk`;
    const phone = `0321-${String(2220000 + i + 1).padStart(7, '0')}`;

    const parentUser = await User.findOneAndUpdate(
      { email },
      {
        $set: {
          organizationId: org._id,
          townId: town._id,
          fullName: p.fullName,
          email,
          passwordHash: commonPasswordHash,
          phoneNumber: phone,
          designation: 'Guardian',
          baseRole: BASE_ROLES.PARENT,
          role: ROLES.PARENT,
          scope: SCOPES.CHILD,
          status: USER_STATUS.ACTIVE,
          tokenVersion: 0,
        },
      },
      { upsert: true, new: true }
    );
    seededParents.push({ user: parentUser, meta: p });
  }
  console.log(`   ✅ Seeded Exactly ${seededParents.length} Parent Accounts.`);

  // 5. Seed Exactly 100 Students (Linked to Parents, Schools, Classes, and Sections)
  console.log('\n🔹 [5/5] Seeding 100 Students with Full Academic Profiles...');
  const seededStudents = [];
  const schoolStudentCount = new Map(); // schoolId -> count

  for (let i = 0; i < 100; i++) {
    // Distribute across 15 schools: i % 15
    const schoolIndex = i % 15;
    const targetSchool = seededSchools[schoolIndex];
    const schoolClasses = schoolClassesMap.get(targetSchool._id.toString()) || [];

    // Select class & section
    const classIdx = i % schoolClasses.length;
    const selectedClassObj = schoolClasses[classIdx];
    const selectedClass = selectedClassObj.classDoc;
    const selectedSection = selectedClassObj.sections[i % selectedClassObj.sections.length];

    // Assign to one of the 24 parents
    // 20 parents get 4 children (80 students), 4 parents get 5 children (20 students) -> Total 100
    let parentIndex;
    if (i < 80) {
      parentIndex = Math.floor(i / 4); // 0 to 19
    } else {
      parentIndex = 20 + Math.floor((i - 80) / 5); // 20 to 23
    }
    const assignedParent = seededParents[parentIndex];

    // Determine gender
    let gender = 'MALE';
    if (targetSchool.genderType === 'GIRLS') {
      gender = 'FEMALE';
    } else if (targetSchool.genderType === 'BOYS') {
      gender = 'MALE';
    } else {
      gender = i % 2 === 0 ? 'MALE' : 'FEMALE';
    }

    const firstNamesPool = gender === 'MALE' ? BOY_FIRST_NAMES : GIRL_FIRST_NAMES;
    const studentFirstName = firstNamesPool[i % firstNamesPool.length];
    const studentFullName = `${studentFirstName} ${assignedParent.user.fullName.split(' ').slice(-1)[0]}`;

    const studentNum = String(i + 1).padStart(3, '0');
    const email = `student${studentNum}.liaquatabad@dmc.gov.pk`;

    const currentSchoolCount = (schoolStudentCount.get(targetSchool._id.toString()) || 0) + 1;
    schoolStudentCount.set(targetSchool._id.toString(), currentSchoolCount);

    const grNumber = 100 + currentSchoolCount;
    const seqStr = String(grNumber).padStart(4, '0');
    const globalStudentId = `${targetSchool.schoolCode}-${seqStr}`;
    const admissionRegisterNumber = `${targetSchool.schoolCode}-2026-${seqStr}`;
    const bFormNumber = `42101-${String(3000000 + i * 2222).slice(0, 7)}-${(i % 9) + 1}`;

    const birthYear = 2018 - Math.min(selectedClass.numericGrade, 10) + 1; // Approx 6yo in Class 1, 15yo in Class 10
    const dob = new Date(birthYear, (i * 2) % 12, (i % 25) + 1);

    const userDoc = await User.findOneAndUpdate(
      { email },
      {
        $set: {
          organizationId: org._id,
          townId: town._id,
          schoolId: targetSchool._id,
          fullName: studentFullName,
          email,
          passwordHash: commonPasswordHash,
          phoneNumber: assignedParent.user.phoneNumber,
          designation: 'Student',
          baseRole: BASE_ROLES.STUDENT,
          role: ROLES.STUDENT,
          scope: SCOPES.SELF,
          status: USER_STATUS.ACTIVE,
          tokenVersion: 0,
        },
      },
      { upsert: true, new: true }
    );

    await StudentProfile.findOneAndUpdate(
      { userId: userDoc._id },
      {
        $set: {
          schoolId: targetSchool._id,
          classId: selectedClass._id,
          sectionId: selectedSection._id,
          grNumber,
          admissionRegisterNumber,
          globalStudentId,
          admissionType: 'NEW_ADMISSION',
          studentFullName,
          bFormNumber,
          dateOfBirth: dob,
          dateOfBirthInWords: dob.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
          gender,
          religion: 'ISLAM',
          placeOfBirth: 'Karachi',
          fatherFullName: assignedParent.user.fullName,
          motherFullName: 'Mst. Parveen Akhtar',
          relationshipWithStudent: assignedParent.meta.relation,
          parentUserId: assignedParent.user._id,
          permanentResidentialAddress: `House #${10 + (i % 80)}, Street 4, Block ${(i % 10) + 1}, Liaquatabad, Karachi`,
          guardianContactNumber: assignedParent.user.phoneNumber,
          guardianCellNumber: assignedParent.user.phoneNumber,
          guardianEmail: assignedParent.user.email,
          admissionClassRequested: selectedClass.name,
          admissionDate: new Date(2026, 2, 1),
          lifecycleStatus: STUDENT_STATUS.ACTIVE,
        },
      },
      { upsert: true, new: true }
    );

    seededStudents.push(userDoc);
  }

  // Update lastGrNumber & lastGlobalSequence on each school
  for (const school of seededSchools) {
    const count = schoolStudentCount.get(school._id.toString()) || 0;
    await School.findByIdAndUpdate(school._id, {
      $set: {
        lastGrNumber: 100 + count,
        lastGlobalSequence: count,
      },
    });
  }

  console.log(`   ✅ Seeded Exactly ${seededStudents.length} Students with Full Institutional Profiles.`);

  console.log('\n==============================================================================');
  console.log('🏆 SEEDING SUMMARY');
  console.log('==============================================================================');
  console.log(` • Schools:         ${seededSchools.length} (From Official Image)`);
  console.log(` • Staff Accounts:  ${seededStaffUsers.length} (15 HMs, 35 Teachers, 10 Non-Teaching)`);
  console.log(` • Parent Accounts: ${seededParents.length} (24 Guardians)`);
  console.log(` • Student Accounts:${seededStudents.length} (Linked to Parents & Classes)`);
  console.log(` • Default Password: ${SEED_DEFAULT_PASSWORD}`);
  console.log('==============================================================================\n');

  return {
    schoolsCount: seededSchools.length,
    staffCount: seededStaffUsers.length,
    parentsCount: seededParents.length,
    studentsCount: seededStudents.length,
  };
}

// Execute standalone when run directly
if (process.argv[1] && process.argv[1].endsWith('seedLiaquatabadSchoolsAndUsers.js')) {
  runLiaquatabadSeed()
    .then(() => {
      console.log('✅ Seed completed successfully. Exiting.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ Seed execution failed:', err);
      process.exit(1);
    });
}
