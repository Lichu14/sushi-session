import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { MerchantController } from './merchant.controller.js';
import { MerchantVisitsService } from './merchant-visits.service.js';
import { MerchantAuthorizationService } from './merchant-authorization.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [MerchantController],
  providers: [MerchantAuthorizationService, MerchantVisitsService],
  exports: [MerchantAuthorizationService],
})
export class MerchantModule {}
