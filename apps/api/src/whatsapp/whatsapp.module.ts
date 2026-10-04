import { Module } from '@nestjs/common';
import { AdminGuard } from '../admin/admin.guard';
import { TripsModule } from '../trips/trips.module';
import { CommentNotifierService } from './comment-notifier.service';
import { VisitorsService } from './visitors.service';
import { VisitorsController, WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';

@Module({
  imports: [TripsModule],
  controllers: [VisitorsController, WhatsappController],
  providers: [AdminGuard, WhatsappService, VisitorsService, CommentNotifierService],
  exports: [WhatsappService, VisitorsService, CommentNotifierService],
})
export class WhatsappModule {}
