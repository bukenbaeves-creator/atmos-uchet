// Стартовые значения справочников и общие константы (используются сидом и отчётами).

// Стадии итога консультации (воронка) — раздел 7.1 ТЗ
export const STAGES = [
  'Согласована дата операции (без оплаты)',
  'Назначена операция — оплачен аванс',
  'Операция — заключён договор и 100% оплата',
  'Услуга оказана',
  'Планирует операцию',
  'Отказался пациент от операции',
  'Отказались от консультации',
  'Клиент не пришёл на консультацию',
  'Отказал врач в операции',
];

// Стадии, означающие конверсию в оплату (раздел 8 ТЗ)
export const PAY_STAGES = [
  'Назначена операция — оплачен аванс',
  'Операция — заключён договор и 100% оплата',
];

export const PAY_METHODS = ['Через терминал', 'Наличные', 'Рассрочка', 'На счёт ТОО'];

export const TERMINALS = ['Каспи Т1', 'Каспи Т3', 'Форте', 'Халык'];

export const ZAPIS = ['ВРАЧ', 'КЛИНИКА', 'КЛИНИКА+ВРАЧ'];

export const VID = ['Офлайн', 'Онлайн'];

// Статус консультации: состоялась ли (для KPI — в расчёт идут только «Прошёл консультацию»)
export const KONS_STATUS = ['Прошёл консультацию', 'Не прошёл консультацию'];
// ВАЖНО: эти значения используются в логике расчёта KPI (kpi.service.ts). Не переименовывать
// в справочнике без правки кода — иначе KPI молча перестанет их учитывать.
export const KONS_ATTENDED = KONS_STATUS[0];
export const KONS_NOT_ATTENDED = KONS_STATUS[1];
// «Онлайн»-вид консультации — тоже участвует в расчёте (онлайн-ставка KPI).
export const VID_ONLINE = 'Онлайн';

export const DOCTORS = [
  'Кулесбаев',
  'Бекремитов',
  'Сулейманова',
  'Мартынов',
  'Тлербергенов',
  'Литвинов',
  'Сагадатов',
];

export const OP_TYPES = [
  'Риносептопластика',
  'Ринопластика',
  'Блефаропластика верхняя',
  'Блефаропластика нижняя',
  'Блефаропластика круговая',
  'Височный лифтинг',
  'Подтяжка лица',
  'Отопластика',
  'Липосакция',
  'Абдоминопластика',
];

export const SERVICE_TYPES = [
  'Предоплата',
  'Консультация',
  'Операция',
  'Перевязка',
  'Анализы',
  'Наркоз',
  'Косметология',
];

// Вид услуги, означающий предоплату (аванс) — берётся только за операцию.
export const PREPAYMENT_SERVICE = 'Предоплата';

export const MANAGERS = ['Айгерим', 'Динара', 'Марат', 'Жанна', 'Асель'];

// Ставки KPI по умолчанию (тенге за одну запись). Меняются админом в интерфейсе.
// Ниже — параметры мини-дашборда качества (тоже настраиваются админом, хранятся в Setting).
export const KPI_DEFAULTS = {
  kpi_consultation_rate: '3000',
  kpi_operation_rate: '30000',
  // срок внесения итога после даты консультации, часов (24 ≈ «до конца дня консультации»)
  kpi_timeliness_hours: '24',
  // минимальная длина итога (деталей), символов
  kpi_min_result_len: '40',
  // окно сравнения итогов на шаблонность (M дней)
  kpi_template_days: '30',
  // окно конверсии консультации в операцию (K дней)
  kpi_conversion_days: '90',
  // целевые пороги светофора (%): зелёный / жёлтый
  kpi_target_quality_green: '90',
  kpi_target_quality_yellow: '70',
  kpi_target_timeliness_green: '90',
  kpi_target_timeliness_yellow: '70',
  kpi_target_conversion_green: '35',
  kpi_target_conversion_yellow: '25',
};

// Коды регистрации по умолчанию (админ обязан сменить их в интерфейсе).
// Роль при регистрации определяется введённым кодом.
export const REG_CODE_DEFAULTS = {
  reg_code_operator: 'operator-2026',
  reg_code_admin: 'admin-2026',
};

export const CITIES = [
  'Алматы',
  'Астана',
  'Шымкент',
  'Караганда',
  'Актобе',
  'Тараз',
  'Павлодар',
  'Усть-Каменогорск',
  'Атырау',
  'Костанай',
];

// ===== Модуль «Выплаты врачам» =====

// Системные компоненты расчёта выплат. Создаются сидом с isSystem:true (idempotent
// upsert по code, см. seed/index.ts). Ставки эквайринга сидом НЕ создаются — их
// отсутствие должно приводить к явной ошибке расчёта, а не к молчаливому нулю.
import type { ComponentValueSource, ComponentDirection, CalcStage } from '@prisma/client';

export const PAYOUT_COMPONENTS: {
  code: string;
  name: string;
  valueSource: ComponentValueSource;
  direction: ComponentDirection;
  defaultStage: CalcStage;
  operationField: string | null;
}[] = [
  { code: 'acquiring', name: 'Комиссия банка', valueSource: 'pct_of_payments', direction: 'deduction', defaultStage: 'before_share', operationField: null },
  { code: 'anesthesia', name: 'Наркоз (общий)', valueSource: 'operation_field', direction: 'deduction', defaultStage: 'before_share', operationField: 'anesthesiaCost' },
  // Седация — отдельный вид анестезии со своей ценой: сумма по таблице «вид операции → сумма».
  { code: 'sedation', name: 'Седация', valueSource: 'table_by_op_type', direction: 'deduction', defaultStage: 'before_share', operationField: null },
  { code: 'implants', name: 'Импланты', valueSource: 'operation_field', direction: 'deduction', defaultStage: 'before_share', operationField: 'implantsCost' },
  { code: 'materials', name: 'Расходные материалы', valueSource: 'warehouse_or_norm', direction: 'deduction', defaultStage: 'before_share', operationField: null },
  { code: 'assistant', name: 'Медсестра / ассистент', valueSource: 'operation_field', direction: 'deduction', defaultStage: 'before_share', operationField: 'assistantCost' },
  { code: 'operation_tax', name: 'Налог с операции', valueSource: 'pct_of_base', direction: 'deduction', defaultStage: 'before_share', operationField: null },
  { code: 'day_rent', name: 'Аренда операционного дня', valueSource: 'per_day', direction: 'deduction', defaultStage: 'after_share', operationField: null },
  { code: 'admin_bonus', name: 'Бонус администратора', valueSource: 'table_by_source', direction: 'deduction', defaultStage: 'after_share', operationField: null },
];

// Соответствие категория справочника -> список значений (для сида)
export const DICTIONARY_SEED: Record<string, string[]> = {
  city: CITIES,
  doctor: DOCTORS,
  op_type: OP_TYPES,
  pay_method: PAY_METHODS,
  terminal: TERMINALS,
  service_type: SERVICE_TYPES,
  consultation_stage: STAGES,
  vid: VID,
  kons_status: KONS_STATUS,
  zapis: ZAPIS,
  manager: MANAGERS,
};

// Способ оплаты, при котором банк берёт комиссию эквайринга (остальные — без комиссии).
export const TERMINAL_METHOD = 'Через терминал';
