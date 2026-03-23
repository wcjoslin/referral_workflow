import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  moduleNameMapper: {
    // Redirect @kno2/bluebutton to a side-effect-free stub so the browser-built
    // webpack bundle (which requires window/self) never loads in Node/Jest.
    '^@kno2/bluebutton$': '<rootDir>/tests/__mocks__/bluebutton.stub.ts',
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { strict: true, esModuleInterop: true } }],
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/index.ts', '!src/db/migrate.ts'],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
};

export default config;
