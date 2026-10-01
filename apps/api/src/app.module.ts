import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { ConfigModule } from '@nestjs/config';
import { envFilePath, validateEnvironment } from './config/environment.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './auth/auth.module.js';
import { VisitsModule } from './visits/visits.module.js';
import { MerchantModule } from './merchant/merchant.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath,
      cache: true,
      validate: validateEnvironment,
      expandVariables: false,
    }),
    PrismaModule,
    AuthModule,
    VisitsModule,
    MerchantModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
