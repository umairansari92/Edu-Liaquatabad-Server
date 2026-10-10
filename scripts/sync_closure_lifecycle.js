import dotenv from 'dotenv';
dotenv.config();
import { connectDatabase } from '../config/database.js';
import HolidayCalendar from '../src/models/HolidayCalendar.js';
import { getKarachiDateString } from '../src/utils/karachiTime.js';

async function run() {
  await connectDatabase();
  const todayPkt = getKarachiDateString(new Date());
  console.log(`[Closure Lifecycle Sync] Authoritative PKT Today: ${todayPkt}`);

  const activePastRecords = await HolidayCalendar.find({
    status: { $in: ['ACTIVE', 'SCHEDULED'] },
    endDate: { $lt: todayPkt },
  });

  console.log(`Found ${activePastRecords.length} expired closures needing lifecycle transition:`);
  for (const record of activePastRecords) {
    console.log(`- ID: ${record._id}, Title: "${record.title}", Dates: ${record.startDate} to ${record.endDate}, Old Status: ${record.status}`);
    record.status = 'EXPIRED';
    await record.save();
    console.log(`  -> Transitioned to EXPIRED.`);
  }

  const scheduledCurrentRecords = await HolidayCalendar.find({
    status: 'SCHEDULED',
    startDate: { $lte: todayPkt },
    endDate: { $gte: todayPkt },
  });

  console.log(`Found ${scheduledCurrentRecords.length} scheduled closures needing activation:`);
  for (const record of scheduledCurrentRecords) {
    console.log(`- ID: ${record._id}, Title: "${record.title}", Dates: ${record.startDate} to ${record.endDate}, Old Status: ${record.status}`);
    record.status = 'ACTIVE';
    await record.save();
    console.log(`  -> Transitioned to ACTIVE.`);
  }

  console.log('[Closure Lifecycle Sync] Completed successfully.');
  process.exit(0);
}

run().catch((err) => {
  console.error('[Closure Lifecycle Sync Error]', err);
  process.exit(1);
});
