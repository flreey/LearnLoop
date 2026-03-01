import * as os from 'os';
import * as path from 'path';

export interface AppConfig {
  dbDir: string;
  dbPath: string;
  retrieval: {
    recencyWeight: number;
    relevanceWeight: number;
    importanceWeight: number;
    decayLambda: number;
    memoryInjectionLimit: number;
    reflectionInjectionLimit: number;
  };
}

const DEFAULT_DB_DIR = path.join(os.homedir(), '.openclaw', 'learnloop');
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'learnloop.db');

export const defaultConfig: AppConfig = {
  dbDir: DEFAULT_DB_DIR,
  dbPath: DEFAULT_DB_PATH,
  retrieval: {
    recencyWeight: 0.3,
    relevanceWeight: 0.5,
    importanceWeight: 0.2,
    decayLambda: 0.01,
    memoryInjectionLimit: 10,
    reflectionInjectionLimit: 5,
  },
};

export function getConfig(): AppConfig {
  return { ...defaultConfig };
}
