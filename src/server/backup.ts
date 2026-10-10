import fs from 'fs';
import path from 'path';
import { db, DATA_DIR } from './db';

const pad = (n: number) => String(n).padStart(2, '0');
const backupDir = () => process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.join(DATA_DIR, 'backups');

export async function createManualBackup() {
  const dir=backupDir();
  fs.mkdirSync(dir,{recursive:true});
  const d=new Date(),stamp=`${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const filename=`inventory-manual-${stamp}.db`,file=path.join(dir,filename);
  await db.backup(file);
  return {filename,file,size:fs.statSync(file).size,createdAt:fs.statSync(file).mtime.toISOString()};
}

export function listBackups() {
  const dir=backupDir();
  if(!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((filename)=>/^inventory-[\w.-]+\.db$/.test(filename)).map((filename)=>{
    const stat=fs.statSync(path.join(dir,filename));
    return {filename,size:stat.size,createdAt:stat.mtime.toISOString()};
  }).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}

export function resolveBackup(filename:string) {
  if(path.basename(filename)!==filename || !/^inventory-[\w.-]+\.db$/.test(filename)) return null;
  const file=path.join(backupDir(),filename);
  return fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
}

/**
 * Saves a copy of the database now and every 6 hours.
 * One file per day (later copies the same day replace the earlier one). Keeps the newest 30.
 * Set BACKUP_DIR to a USB drive or second disk, e.g. E:\inventory-backups
 */
export function startBackups() {
  const dir = backupDir();

  const run = async () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const d = new Date();
      const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      await db.backup(path.join(dir, `inventory-${stamp}.db`));
      const files = fs.readdirSync(dir).filter((f) => /^inventory-.*\.db$/.test(f)).sort();
      while (files.length > 30) fs.unlinkSync(path.join(dir, files.shift() as string));
      console.log(`Backup saved to ${dir}`);
    } catch (e) {
      console.error('BACKUP FAILED:', e);
    }
  };

  void run();
  setInterval(run, 6 * 3600 * 1000);
}
